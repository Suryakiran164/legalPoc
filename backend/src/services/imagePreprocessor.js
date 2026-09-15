/**
 * Image preprocessing for OCR pipeline.
 * Preserves original image, creates processed variants + metadata.
 *
 * Operations (best-effort, depends on sharp availability):
 *  - resize (max dimension 2000px to limit Gemini payload)
 *  - sharpen
 *  - contrast enhancement / normalize
 *  - grayscale optional
 *  - denoise (median)
 *  - rotation detection (exif auto-rotate)
 *  - crop/region detection (placeholder)
 *
 * If sharp is not installed, preprocessing is a no-op but preserves metadata.
 */

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[imagePreprocessor] sharp not available, preprocessing will be passthrough:', e.message);
}

/**
 * Process a single image buffer.
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @param {object} opts { maxDimension, grayscale, sharpen, normalize }
 * @returns {Promise<{original: Buffer, processed: Buffer, metadata: object, previewBase64?:string}>}
 */
async function preprocessImage(buffer, mimetype, opts = {}) {
  const maxDimension = opts.maxDimension || 2000;
  const start = Date.now();

  const originalSize = buffer.length;
  let processed = buffer;
  let metadata = {
    original_size: originalSize,
    original_mimetype: mimetype,
    processed: false,
    operations: [],
    width: null,
    height: null,
    duration_ms: 0,
  };

  if (!sharp) {
    return { original: buffer, processed: buffer, metadata: { ...metadata, warnings: ['sharp not available, skipping preprocessing'] } };
  }

  try {
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate(); // auto-rotate based on EXIF

    const infoBefore = await sharp(buffer).metadata().catch(() => ({}));
    metadata.width = infoBefore.width;
    metadata.height = infoBefore.height;

    // Resize if larger than maxDimension
    if (infoBefore.width > maxDimension || infoBefore.height > maxDimension) {
      pipeline = pipeline.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
      metadata.operations.push(`resize:${maxDimension}`);
    }

    // Sharpen
    if (opts.sharpen !== false) {
      pipeline = pipeline.sharpen({ sigma: 1, m1: 1, m2: 0.5 });
      metadata.operations.push('sharpen');
    }

    // Normalize / contrast enhancement
    if (opts.normalize !== false) {
      pipeline = pipeline.normalize(); // stretch contrast
      metadata.operations.push('normalize');
    }

    // Optional grayscale - disabled by default because color helps Gemini
    if (opts.grayscale) {
      pipeline = pipeline.grayscale();
      metadata.operations.push('grayscale');
    }

    // Median for denoise (light)
    if (opts.denoise) {
      pipeline = pipeline.median(3);
      metadata.operations.push('median-denoise');
    }

    // Output as JPEG for consistent size (preserve if PNG/WebP with transparency? JPEG is fine for OCR)
    // Keep original mimetype for fallback but convert to jpeg for Gemini payload to reduce size
    const outMimetype = mimetype === 'image/png' || mimetype === 'image/webp' ? mimetype : 'image/jpeg';
    if (outMimetype === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
    else if (outMimetype === 'image/png') pipeline = pipeline.png({ compressionLevel: 8 });
    else if (outMimetype === 'image/webp') pipeline = pipeline.webp({ quality: 88 });

    processed = await pipeline.toBuffer();
    const infoAfter = await sharp(processed).metadata().catch(() => ({}));
    metadata.processed = true;
    metadata.processed_size = processed.length;
    metadata.processed_mimetype = outMimetype;
    metadata.width_after = infoAfter.width;
    metadata.height_after = infoAfter.height;

    // Only use processed if it is not drastically smaller (which would lose detail)
    // But for OCR, slightly smaller is okay if we resized large images
    metadata.compression_ratio = (processed.length / originalSize).toFixed(2);

  } catch (e) {
    console.warn('[imagePreprocessor] preprocessing failed, using original:', e.message);
    processed = buffer;
    metadata.processed = false;
    metadata.error = e.message;
    metadata.warnings = [e.message];
  }

  metadata.duration_ms = Date.now() - start;

  // For small preview, we could generate base64 but skip for PoC size
  return { original: buffer, processed, metadata };
}

/**
 * Preprocess multiple images, preserving originals.
 * @param {Array<{buffer: Buffer, mimetype:string, originalname:string}>} images
 * @param {object} opts
 * @returns {Promise<Array<{original:Buffer, processed:Buffer, metadata:object, originalname:string, mimetype:string, image_id:string}>>}
 */
async function preprocessImages(images, opts = {}) {
  const results = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const { original, processed, metadata } = await preprocessImage(img.buffer, img.mimetype, opts);
    results.push({
      original,
      processed,
      metadata,
      originalname: img.originalname,
      mimetype: img.mimetype,
      image_id: `img_${i}`,
      // For Gemini, we send processed but keep original as evidence
      bufferForOcr: processed, // could choose processed for Gemini, original for EasyOCR? We'll use processed for both to improve OCR
      bufferForStorage: original, // original is authoritative evidence
    });
  }
  return results;
}

/**
 * Quick estimate of image quality for warnings
 */
function assessImageQuality(buffer, metadata) {
  const warnings = [];
  if (metadata.original_size < 20 * 1024) warnings.push('Low resolution / very small file');
  if (metadata.width && metadata.width < 600) warnings.push('Low resolution: width < 600px');
  if (metadata.height && metadata.height < 600) warnings.push('Low resolution: height < 600px');
  // Add more heuristics if we have sharp stats
  return warnings;
}

module.exports = { preprocessImage, preprocessImages, assessImageQuality };
