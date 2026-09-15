/**
 * OCR Pipeline: Gemini-first → reliability check → fallback → normalized → rule engine
 *
 * Implements:
 *  - 5. OCR FALLBACK
 *  - 6. SMART FALLBACK (reliability scoring)
 *  - 7. OPTIONAL DUAL-OCR VERIFICATION
 *  - 8. IMAGE PREPROCESSING
 *  - 9. MULTI-IMAGE SCANS
 *  - 10. MULTILINGUAL
 *  - 11. OCR NORMALIZATION
 *  - 14. IMPORTANT DISTINCTION
 *  - 15. CONFIDENCE
 *  - 16. EVIDENCE
 */

const { runGeminiOcr, getGeminiConfig } = require('./geminiService');
const { runOcrForImages, easyOcrToNormalized } = require('./ocrService');
const { preprocessImages } = require('./imagePreprocessor');
const { createEmptyNormalized, compareNormalized, mergeMultiImageResults, validateNormalized } = require('./normalizedOcr');

const GEMINI_CONFIDENCE_THRESHOLD = parseFloat(process.env.GEMINI_CONFIDENCE_THRESHOLD || '0.6');
const ENABLE_DUAL_OCR = (process.env.ENABLE_DUAL_OCR || 'false').toLowerCase() === 'true';
const GEMINI_FALLBACK_ON_LOW_COVERAGE = true;

function computeReliabilityScore(normalized, opts = {}) {
  const rawTextLength = (normalized.fields?.raw_text || '').length;
  const evidenceCount = normalized.evidence?.length || 0;

  // Text coverage: how much text did Gemini extract? Use evidence length vs block count fallback
  // If original image had substantial text but Gemini extracted almost nothing, score low.
  // We approximate textCoverage = min(1, rawTextLength / 100) - but for short labels 100 may be high; use 50
  const textCoverage = Math.min(1, rawTextLength / 80 + evidenceCount * 0.05);
  // Field coverage: mandatory fields found / 9
  const mandatoryKeys = [
    'manufacturer',
    'country_of_origin',
    'net_quantity',
    'mrp',
    'manufacture_or_packing_date',
    'consumer_care',
  ];
  let found = 0;
  for (const k of mandatoryKeys) {
    const decl = normalized.declarations?.[k];
    if (decl && decl.status !== 'not_found' && decl.status !== 'not_applicable' && decl.confidence > 0.3) found += 1;
  }
  const fieldCoverage = found / mandatoryKeys.length; // 0..1

  // Confidence: overall
  const confidence = normalized.confidence ?? 0;

  // Schema validity: 1 if valid, 0 if errors
  const validation = validateNormalized(normalized);
  const schemaValidity = validation.valid ? 1 : 0.2;

  // Warnings penalty
  const warningsPenalty = normalized.warnings?.length ? Math.max(0.5, 1 - normalized.warnings.length * 0.1) : 1;

  const score = textCoverage * fieldCoverage * Math.max(0.2, confidence) * schemaValidity * warningsPenalty;

  return {
    score,
    breakdown: { textCoverage, fieldCoverage, confidence, schemaValidity, warningsPenalty, rawTextLength, evidenceCount, foundMandatory: found },
  };
}

function shouldFallback(normalized, reliability, opts = {}) {
  const threshold = opts.threshold ?? GEMINI_CONFIDENCE_THRESHOLD;

  // Hard fallback conditions per spec section 5 & 6
  if (!normalized || normalized.status === 'failed') return { fallback: true, reason: 'Gemini status failed' };
  if (normalized.confidence < 0.35) return { fallback: true, reason: `Very low confidence ${normalized.confidence.toFixed(2)}` };
  if (reliability.score < threshold) return { fallback: true, reason: `Reliability score ${reliability.score.toFixed(2)} < threshold ${threshold}` };

  const rawLen = (normalized.fields?.raw_text || '').length;
  if (rawLen < 10) return { fallback: true, reason: 'Almost no text detected by Gemini' };
  if (normalized.evidence.length === 0) return { fallback: true, reason: 'No evidence blocks from Gemini' };

  // Invalid structured output already handled, but check mandatory fields missing unexpectedly
  const mandatoryMissing = ['mrp', 'net_quantity'].filter(k => {
    const d = normalized.declarations?.[k];
    return !d || d.status === 'not_found';
  });
  if (mandatoryMissing.length >= 2 && normalized.warnings.length === 0) {
    // Unexpected: both MRP and net quantity missing - likely extraction failure, fallback may help
    return { fallback: true, reason: `Mandatory fields missing: ${mandatoryMissing.join(', ')}` };
  }

  // Malformed or exceeds limits handled via exceptions earlier

  return { fallback: false, reason: 'Gemini result sufficient' };
}

/**
 * Main pipeline entry.
 * @param {Array<{buffer:Buffer, originalname:string, mimetype:string}>} images
 * @param {object} opts { enableDual, threshold }
 * @returns {Promise<{normalized: object, pipeline: object}>}
 */
async function runPipeline(images, opts = {}) {
  if (!images || images.length === 0) throw new Error('No images provided to OCR pipeline');

  const enableDual = opts.enableDual ?? ENABLE_DUAL_OCR;
  const threshold = opts.threshold ?? GEMINI_CONFIDENCE_THRESHOLD;
  const pipelineMeta = {
    started_at: new Date().toISOString(),
    images_count: images.length,
    gemini: null,
    fallback: null,
    preprocessing: [],
    reliability: null,
    fallback_used: false,
    fallback_reason: null,
    dual_enabled: enableDual,
    conflicts: [],
    duration_ms: 0,
    engine_used: 'unknown',
  };

  const pipelineStart = Date.now();

  // 1. Preprocess images (preserve originals)
  let preprocessed;
  try {
    preprocessed = await preprocessImages(images, { maxDimension: 2000, sharpen: true, normalize: true });
    pipelineMeta.preprocessing = preprocessed.map(p => ({
      image_id: p.image_id,
      original_size: p.metadata.original_size,
      processed_size: p.metadata.processed_size,
      operations: p.metadata.operations,
      duration_ms: p.metadata.duration_ms,
    }));
  } catch (e) {
    console.warn('[ocrPipeline] preprocessing failed, using originals:', e.message);
    // Fallback to originals as processed
    preprocessed = images.map((img, i) => ({
      original: img.buffer,
      processed: img.buffer,
      metadata: { error: e.message },
      originalname: img.originalname,
      mimetype: img.mimetype,
      image_id: `img_${i}`,
      bufferForOcr: img.buffer,
      bufferForStorage: img.buffer,
    }));
  }

  // Build Gemini inputs (use processed buffers)
  const geminiInputs = preprocessed.map(p => ({
    buffer: p.processed || p.bufferForOcr || p.original,
    mimetype: p.mimetype,
    image_id: p.image_id,
    originalname: p.originalname,
  }));

  // Build EasyOCR inputs (also processed, but could use original - for now same)
  const easyOcrInputs = preprocessed.map(p => ({
    buffer: p.processed || p.bufferForOcr || p.original,
    originalname: p.originalname,
    mimetype: p.mimetype,
    image_id: p.image_id,
  }));

  let geminiNormalized = null;
  let geminiError = null;
  let geminiReliability = null;
  let shouldUseFallback = false;
  let fallbackReason = null;

  // 2. Try Gemini first
  const geminiStart = Date.now();
  try {
    geminiNormalized = await runGeminiOcr(geminiInputs, { threshold });
    pipelineMeta.gemini = {
      status: 'success',
      duration_ms: Date.now() - geminiStart,
      confidence: geminiNormalized.confidence,
      language_detected: geminiNormalized.language_detected,
      warnings: geminiNormalized.warnings,
      model: geminiNormalized.analysis_metadata?.gemini_model,
    };
    geminiReliability = computeReliabilityScore(geminiNormalized);
    pipelineMeta.reliability = geminiReliability;
    const fallbackDecision = shouldFallback(geminiNormalized, geminiReliability, { threshold });
    shouldUseFallback = fallbackDecision.fallback;
    fallbackReason = fallbackDecision.reason;
    pipelineMeta.fallback_reason = fallbackReason;
  } catch (err) {
    geminiError = err;
    pipelineMeta.gemini = {
      status: 'failed',
      duration_ms: Date.now() - geminiStart,
      error_code: err.info?.error_code || err.code || 'UNKNOWN',
      error_message: err.message,
      user_message: err.info?.user_message || err.message,
      attempts: err.info?.attempts,
    };
    shouldUseFallback = true;
    fallbackReason = err.info?.user_message || err.message || 'Gemini failed';
    pipelineMeta.fallback_reason = fallbackReason;
  }

  // 3. Decide on fallback / dual
  let finalNormalized = null;
  let fallbackNormalizedPerImage = null;
  let fallbackMerged = null;

  // Helper to run fallback
  async function runFallback() {
    const fbStart = Date.now();
    try {
      // runOcrForImages returns per-image normalized
      const perImage = await runOcrForImages(easyOcrInputs);
      const merged = mergeMultiImageResults(perImage, preprocessed.map(p => ({ image_id: p.image_id, mimetype: p.mimetype, operations: p.metadata.operations })));
      merged.fallback_raw = perImage.map(p => p.fallback_raw);
      merged.analysis_metadata = {
        ...merged.analysis_metadata,
        fallback_duration_ms: Date.now() - fbStart,
        fallback_images: perImage.length,
      };
      pipelineMeta.fallback = {
        status: 'success',
        duration_ms: Date.now() - fbStart,
        confidence: merged.confidence,
        warnings: merged.warnings,
        per_image_count: perImage.length,
      };
      return { perImage, merged };
    } catch (e) {
      pipelineMeta.fallback = {
        status: 'failed',
        duration_ms: Date.now() - fbStart,
        error_message: e.message,
      };
      throw e;
    }
  }

  if (enableDual && geminiNormalized && !geminiError) {
    // Dual mode: run both and compare, even if Gemini reliable
    try {
      const { perImage, merged } = await runFallback();
      fallbackNormalizedPerImage = perImage;
      fallbackMerged = merged;

      // Compare
      const conflicts = compareNormalized(geminiNormalized, merged);
      pipelineMeta.conflicts = conflicts;
      pipelineMeta.fallback_used = true;
      pipelineMeta.engine_used = 'gemini+easyocr';

      // If conflicts, mark fields as requires_human_verification in final
      // For now, choose gemini as primary but annotate conflicts
      const multiGemini = geminiNormalized.images?.length > 1 ? geminiNormalized : geminiNormalized; // Gemini already handled multi-image as single call
      // For dual, merged Gemini already covers multi-image; EasyOCR merged also
      // We will create a combined normalized that is Gemini-based but with conflict metadata
      finalNormalized = {
        ...geminiNormalized,
        engine: 'gemini+easyocr',
        primary_engine: 'gemini',
        fallback_used: true,
        fallback_raw: merged.fallback_raw,
        conflicts,
        warnings: [...new Set([...(geminiNormalized.warnings || []), ...(merged.warnings || []), ...conflicts.map(c => `Conflict in ${c.field}: ${c.gemini_value} vs ${c.fallback_value}`)])],
      };
      // Downgrade conflicting fields to requires_human_verification
      for (const c of conflicts) {
        finalNormalized.field_statuses[c.flat_key] = 'requires_human_verification';
        // Also mark declaration
        if (finalNormalized.declarations[c.field]) {
          finalNormalized.declarations[c.field].status = 'conflicting';
          finalNormalized.declarations[c.field].confidence = Math.min(finalNormalized.declarations[c.field].confidence, 0.5);
        }
      }
      // If Gemini was unreliable, fallback may be better: choose higher reliability?
      const fallbackReliability = computeReliabilityScore(merged);
      if (fallbackReliability.score > geminiReliability.score + 0.15) {
        // Prefer fallback if significantly more reliable
        finalNormalized = {
          ...merged,
          engine: 'gemini+easyocr',
          primary_engine: 'easyocr',
          fallback_used: true,
          gemini_raw: geminiNormalized.gemini_raw,
          conflicts,
          warnings: finalNormalized.warnings,
        };
      }
    } catch (e) {
      console.error('[ocrPipeline] dual fallback failed:', e.message);
      // If dual fallback fails, use Gemini
      finalNormalized = geminiNormalized;
      pipelineMeta.fallback_used = false;
      pipelineMeta.engine_used = 'gemini';
    }
  } else if (shouldUseFallback) {
    // Standard fallback path
    pipelineMeta.fallback_used = true;
    try {
      const { perImage, merged } = await runFallback();
      fallbackNormalizedPerImage = perImage;
      fallbackMerged = merged;

      if (geminiNormalized && geminiError === null) {
        // Gemini succeeded but unreliable - we already decided to fallback.
        // Compare for conflicts but use fallback as primary
        const conflicts = compareNormalized(geminiNormalized, merged);
        pipelineMeta.conflicts = conflicts;
        finalNormalized = {
          ...merged,
          engine: 'fallback',
          primary_engine: 'gemini',
          fallback_used: true,
          gemini_raw: geminiNormalized.gemini_raw,
          conflicts,
          analysis_metadata: {
            ...merged.analysis_metadata,
            gemini_failure_reason: fallbackReason,
            gemini_confidence: geminiNormalized.confidence,
          },
        };
        // Keep Gemini warnings for transparency
        finalNormalized.warnings = [...(merged.warnings || []), `Gemini insufficient: ${fallbackReason}`];
        pipelineMeta.engine_used = 'fallback';
      } else {
        // Gemini failed outright
        finalNormalized = {
          ...merged,
          engine: 'easyocr',
          primary_engine: 'easyocr',
          fallback_used: true,
          gemini_error: geminiError?.info || { message: geminiError?.message },
          analysis_metadata: {
            ...merged.analysis_metadata,
            gemini_error: geminiError?.info || geminiError?.message,
          },
        };
        pipelineMeta.engine_used = 'easyocr';
      }
    } catch (fallbackErr) {
      // Both failed
      console.error('[ocrPipeline] fallback also failed:', fallbackErr.message);
      if (geminiNormalized) {
        finalNormalized = geminiNormalized;
        finalNormalized.warnings = [...(finalNormalized.warnings || []), `Fallback also failed: ${fallbackErr.message}`];
        pipelineMeta.engine_used = 'gemini';
        pipelineMeta.fallback_used = false;
      } else {
        // Create failed normalized
        finalNormalized = createEmptyNormalized({
          engine: 'failed',
          primary_engine: 'none',
          fallback_used: false,
          status: 'failed',
          confidence: 0,
          warnings: [geminiError?.message || 'Gemini failed', fallbackErr.message],
          analysis_metadata: {
            gemini_error: geminiError?.info,
            fallback_error: fallbackErr.message,
          },
        });
        pipelineMeta.engine_used = 'failed';
      }
    }
  } else {
    // Gemini succeeds and reliable, no fallback
    finalNormalized = geminiNormalized;
    // For multi-image, Gemini already processed all images together. But if we have multiple images and Gemini returned single, we should still handle merging fallback not needed.
    // However need to handle multi-image merging for Gemini: our gemini service sent all images at once, so result is already product-level.
    // But we should still set fallback_used false
    pipelineMeta.fallback_used = false;
    pipelineMeta.engine_used = 'gemini';
    // If multiple images, we might want to ensure merge logic for evidence - already done inside Gemini (single call)
    // For completeness, if we had split Gemini per image (not currently), we'd merge here.
  }

  // Handle multi-image merging for final result if we have per-image results that were not merged yet
  // For Gemini multi-image case where we sent all images together, finalNormalized already covers all images.
  // For EasyOCR fallback multi-image, merged already.
  // But if we want to ensure image metadata preservation for all cases:
  if (finalNormalized && preprocessed) {
    finalNormalized.images = preprocessed.map(p => ({
      image_id: p.image_id,
      originalname: p.originalname,
      mimetype: p.mimetype,
      metadata: p.metadata,
    }));
    // Ensure overall confidence is set for rule engine
    finalNormalized.fields.ocr_confidence = finalNormalized.confidence;
  }

  pipelineMeta.duration_ms = Date.now() - pipelineStart;
  pipelineMeta.finished_at = new Date().toISOString();

  // Add pipeline meta to normalized for persistence
  finalNormalized.analysis_metadata = {
    ...finalNormalized.analysis_metadata,
    pipeline: pipelineMeta,
  };
  finalNormalized.ocr_engine = pipelineMeta.engine_used;
  finalNormalized.ocr_status = finalNormalized.status;
  finalNormalized.ocr_confidence = finalNormalized.confidence;
  finalNormalized.ocr_attempts = {
    gemini: pipelineMeta.gemini,
    fallback: pipelineMeta.fallback,
  };
  finalNormalized.ocr_warnings = finalNormalized.warnings;
  finalNormalized.field_conflicts = pipelineMeta.conflicts || finalNormalized.conflicts || [];

  return { normalized: finalNormalized, pipeline: pipelineMeta };
}

module.exports = { runPipeline, computeReliabilityScore, shouldFallback };
