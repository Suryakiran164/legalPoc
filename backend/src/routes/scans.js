const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabase, storageBucket } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { runOcr, extractFields } = require('../services/ocrService');
const { runRuleEngine } = require('../services/ruleEngine');
const { generateComplianceReportPdf } = require('../services/pdfService');
const { runPipeline } = require('../services/ocrPipeline');

const router = express.Router();
router.use(requireAuth);

// Simple in-memory rate limiting for AI endpoints (per user, 20/min)
const rateMap = new Map();
function checkRateLimit(userId, limit = 20, windowMs = 60000) {
  const now = Date.now();
  const entry = rateMap.get(userId) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count += 1;
  rateMap.set(userId, entry);
  return entry.count <= limit;
}

function collectFiles(req) {
  // Supports: req.file (single), req.files array, req.files fields object
  if (req.file) return [req.file];
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    const all = [];
    if (req.files.image) all.push(...req.files.image);
    if (req.files.images) all.push(...req.files.images);
    return all;
  }
  return [];
}

async function storeImages(files, userUid, scanId) {
  const stored = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const storagePath = `scans/${userUid}/${scanId}-${i}-${f.originalname}`;
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, f.buffer, { contentType: f.mimetype, upsert: false });
    if (uploadError) throw uploadError;
    const { data: imageData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
    stored.push({
      image_id: `img_${i}`,
      originalname: f.originalname,
      mimetype: f.mimetype,
      storage_path: storagePath,
      image_url: imageData.publicUrl,
      size: f.buffer.length,
    });
  }
  return stored;
}

// ---------------------------------------------------------------------
// POST /api/scans  - upload one or multiple images, run Gemini-first pipeline
// ---------------------------------------------------------------------
// Accepts:
//  - single: field "image"
//  - multiple: field "images" (array, up to 8) or repeated "image"
// Preserves backward compat for single image uploads.
router.post('/', (req, res, next) => {
  // Use fields to accept both
  const handler = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'images', maxCount: 8 }]);
  handler(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  try {
    if (!checkRateLimit(req.user.uid, 15, 60000)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment before retrying.' });
    }

    const files = collectFiles(req);
    // Also handle fallback: if multer fields didn't capture due to array upload with same field name, try req.files as array
    // For clients sending "images" as array via FormData.append('images', file) multiple times, multer.fields handles it.
    // For clients sending "images" via upload.array, we also support that via direct check:
    if (files.length === 0 && req.files) {
      // try alternative parsing
    }

    if (files.length === 0) {
      return res.status(400).json({ error: 'No image uploaded. Use field "image" for single or "images" for multiple (JPEG/PNG/WEBP, up to 8 images, 10MB each).' });
    }
    if (files.length > 8) {
      return res.status(400).json({ error: 'Too many images. Maximum 8 per scan.' });
    }

    const scanId = uuidv4();

    // 1. Store images (preserve originals)
    const storedImages = await storeImages(files, req.user.uid, scanId);
    const primaryImage = storedImages[0];

    // 2. Run Gemini-first pipeline (handles preprocessing, fallback, normalization, multilingual)
    // Prepare inputs for pipeline: use original buffers (pipeline will preprocess internally)
    const pipelineInputs = files.map((f, i) => ({
      buffer: f.buffer,
      originalname: f.originalname,
      mimetype: f.mimetype,
      image_id: `img_${i}`,
    }));

    let pipelineResult;
    let normalized;
    try {
      pipelineResult = await runPipeline(pipelineInputs);
      normalized = pipelineResult.normalized;
    } catch (pipelineErr) {
      console.error('[scans] pipeline failed completely:', pipelineErr);
      // Convert to user-friendly message per spec section 21
      const userMsg = pipelineErr.info?.user_message || pipelineErr.message || 'OCR could not reliably process this image. Please upload a clearer image.';
      return res.status(500).json({ error: userMsg, details: pipelineErr.info || undefined });
    }

    // 3. Extract flat fields for rule engine (normalized already contains fields)
    const extractedFields = normalized.fields || extractFields({ full_text: normalized.fields.raw_text || '', avg_confidence: normalized.confidence });

    // 4. Run deterministic rule engine (never delegate legal decision to LLM)
    const { observations, summary } = await runRuleEngine(extractedFields);

    // 5. Enhance observations with field-level confidence / status for UI
    const enhancedObservations = observations.map(obs => {
      // If field has low confidence or conflicting status, force requires_human_verification per spec 15
      const relatedFieldKeys = {
        'LMPC-001': ['manufacturer_name'],
        'LMPC-002': ['country_of_origin'],
        'LMPC-003': ['commodity_name'],
        'LMPC-004': ['net_quantity_value'],
        'LMPC-005': ['mfg_date'],
        'LMPC-006': ['best_before_date'],
        'LMPC-007': ['mrp_raw'],
        'LMPC-008': ['consumer_care_phone'],
        'LMPC-009': ['unit_sale_price_raw'],
      }[obs.rule_id] || [];

      const lowConf = relatedFieldKeys.some(k => (normalized.field_confidences?.[k] ?? 1) < 0.55);
      const conflicting = relatedFieldKeys.some(k => normalized.field_statuses?.[k] === 'conflicting' || normalized.declarations?.[k.split('_')[0]]?.status === 'conflicting');
      if ((lowConf || conflicting) && obs.status === 'ok') {
        return { ...obs, status: 'requires_human_verification', ai_message: `AI Observation: ${obs.title} could not be confidently assessed and requires human verification.` + (conflicting ? ' Conflicting declarations detected across images/engines.' : '') };
      }
      if (conflicting && obs.status !== 'requires_human_verification') {
        return { ...obs, status: 'requires_human_verification', ai_message: obs.ai_message + ' Conflicting evidence detected - human review required.' };
      }
      return obs;
    });

    // Enhanced summary
    const enhancedSummary = {
      ...summary,
      ok: enhancedObservations.filter(o => o.status === 'ok').length,
      possible_issues: enhancedObservations.filter(o => o.status === 'possible_issue').length,
      requires_verification: enhancedObservations.filter(o => o.status === 'requires_human_verification').length,
    };

    // 6. Build scan doc with extended pipeline metadata (backward compat + new fields)
    // Keep legacy fields: ocr_raw = normalized.fallback_raw or gemini_raw for existing UI
    const legacyOcrRaw = normalized.fallback_raw || normalized.gemini_raw || { blocks: normalized.blocks, full_text: normalized.fields.raw_text, avg_confidence: normalized.confidence };

    const scanDoc = {
      id: scanId,
      owner_uid: req.user.uid,
      owner_email: req.user.email,
      original_filename: files[0].originalname, // legacy
      image_url: primaryImage.image_url, // legacy primary
      storage_path: primaryImage.storage_path, // legacy primary
      // New multi-image fields
      images: storedImages, // array of {image_id, image_url, storage_path, ...}
      // Legacy OCR fields
      ocr_raw: legacyOcrRaw,
      extracted_fields: extractedFields,
      corrected_fields: null,
      observations: enhancedObservations,
      summary: enhancedSummary,
      human_review: { reviewed: false },
      status: 'awaiting_review',
      created_at: new Date().toISOString(),
      // New pipeline fields per spec section 19
      ocr_engine: pipelineResult.pipeline.engine_used, // 'gemini' | 'easyocr' | 'gemini+easyocr' | 'fallback' | 'failed'
      ocr_status: normalized.status,
      ocr_confidence: normalized.confidence,
      ocr_attempts: pipelineResult.pipeline, // full pipeline meta
      ocr_warnings: normalized.warnings || [],
      field_conflicts: normalized.field_conflicts || pipelineResult.pipeline.conflicts || [],
      gemini_raw_response: normalized.gemini_raw || null,
      fallback_ocr_response: normalized.fallback_raw || null,
      analysis_metadata: normalized.analysis_metadata || {},
      normalized_ocr: normalized, // full normalized for debugging/admin
      // Additional helpful top-level for frontend
      language_detected: normalized.language_detected,
      evidence: normalized.evidence,
      uncertain_regions: normalized.uncertain_regions,
    };

    // Attempt insert with new columns, fallback to legacy if migration not applied yet
    let insertError = null;
    let inserted = null;
    const { data: insData, error: err1 } = await supabase.from('scans').insert(scanDoc).select().maybeSingle();
    // Supabase insert with select returns inserted row; but for simplicity we just check error
    if (err1) {
      insertError = err1;
      // If error is about missing column, retry with minimal legacy fields
      const msg = (err1.message || '').toLowerCase();
      if (msg.includes('column') && (msg.includes('ocr_engine') || msg.includes('normalized_ocr') || msg.includes('images'))) {
        console.warn('[scans] Extended columns not yet migrated, falling back to legacy insert:', err1.message);
        const legacyDoc = {
          id: scanId,
          owner_uid: req.user.uid,
          owner_email: req.user.email,
          original_filename: files[0].originalname,
          image_url: primaryImage.image_url,
          storage_path: primaryImage.storage_path,
          ocr_raw: legacyOcrRaw,
          extracted_fields: extractedFields,
          corrected_fields: null,
          observations: enhancedObservations,
          summary: enhancedSummary,
          human_review: { reviewed: false },
          status: 'awaiting_review',
          created_at: new Date().toISOString(),
        };
        const { error: err2 } = await supabase.from('scans').insert(legacyDoc);
        if (err2) throw err2;
        // Return legacyDoc plus extended info in response even if not persisted
        return res.status(201).json({
          ...legacyDoc,
          ocr_engine: scanDoc.ocr_engine,
          ocr_status: scanDoc.ocr_status,
          ocr_confidence: scanDoc.ocr_confidence,
          ocr_warnings: scanDoc.ocr_warnings,
          field_conflicts: scanDoc.field_conflicts,
          images: storedImages,
          analysis_metadata: scanDoc.analysis_metadata,
          language_detected: scanDoc.language_detected,
          evidence: scanDoc.evidence,
          // Signal to frontend that extended fields not persisted
          _warning: 'Extended scan metadata not persisted - please run supabase/migration_gemini_pipeline.sql',
        });
      } else {
        throw err1;
      }
    } else {
      inserted = insData || scanDoc;
    }

    // Prepare response per spec section 20
    const response = inserted || scanDoc;
    // Ensure API returns structured format expected by new frontend, but also legacy fields for old frontend
    res.status(201).json({
      ...response,
      // Spec example top-level envelope for new clients (optional)
      success: true,
      scan_id: scanId,
      ocr: {
        primary_engine: pipelineResult.pipeline.engine_used,
        fallback_used: pipelineResult.pipeline.fallback_used,
        confidence: normalized.confidence,
        status: normalized.status,
        warnings: normalized.warnings,
        conflicts: pipelineResult.pipeline.conflicts || [],
        language_detected: normalized.language_detected,
        attempts: pipelineResult.pipeline,
      },
      analysis: {
        fields: extractedFields,
        observations: enhancedObservations,
        requires_human_verification: enhancedObservations.filter(o => o.status === 'requires_human_verification').map(o => o.rule_id),
        evidence: normalized.evidence,
      },
    });
  } catch (err) {
    console.error(err);
    // User-friendly error mapping per spec 21 (never raw Gemini errors)
    let userMsg = err.message || 'Scan processing failed.';
    if (err.info?.user_message) userMsg = err.info.user_message;
    else if (err.message && err.message.includes('Gemini')) {
      // Already mapped in pipeline
      userMsg = err.message;
    } else if (err.code === 'MISSING_API_KEY') {
      userMsg = 'Primary AI extraction is not configured. Fallback OCR was used, but processing still failed. Check server logs.';
    }
    // Multer errors
    if (err.message && err.message.includes('Only JPEG')) userMsg = err.message;

    res.status(err.status || 500).json({ error: userMsg });
  }
});

// ---------------------------------------------------------------------
// POST /api/scans/:id/analyze - re-analyze existing scan images with current pipeline
// ---------------------------------------------------------------------
router.post('/:id/analyze', async (req, res) => {
  try {
    const { data: scan, error: fetchError } = await supabase.from('scans').select('*').eq('id', req.params.id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });

    // Check ownership
    if (scan.owner_uid !== req.user.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to re-analyze this scan.' });
    }

    // Retrieve images - if new `images` array exists, use it; else legacy single image
    let imagesToFetch = [];
    if (Array.isArray(scan.images) && scan.images.length > 0) {
      imagesToFetch = scan.images;
    } else if (scan.image_url && scan.storage_path) {
      imagesToFetch = [{ image_url: scan.image_url, storage_path: scan.storage_path, originalname: scan.original_filename || 'image.jpg', mimetype: 'image/jpeg' }];
    } else {
      return res.status(400).json({ error: 'No images found for this scan to re-analyze.' });
    }

    // Download images from Supabase Storage (via public URL fetch or supabase download)
    const buffers = [];
    for (let i = 0; i < imagesToFetch.length; i++) {
      const img = imagesToFetch[i];
      try {
        if (img.storage_path) {
          const { data, error } = await supabase.storage.from(storageBucket).download(img.storage_path);
          if (error) throw error;
          const buf = Buffer.from(await data.arrayBuffer());
          buffers.push({ buffer: buf, originalname: img.originalname || `image_${i}.jpg`, mimetype: img.mimetype || 'image/jpeg', image_id: `img_${i}` });
        } else if (img.image_url) {
          // Fallback fetch via public URL using axios
          const axios = require('axios');
          const resp = await axios.get(img.image_url, { responseType: 'arraybuffer', timeout: 15000 });
          buffers.push({ buffer: Buffer.from(resp.data), originalname: img.originalname || `image_${i}.jpg`, mimetype: resp.headers['content-type'] || 'image/jpeg', image_id: `img_${i}` });
        }
      } catch (e) {
        console.warn(`[analyze] failed to fetch image ${i}:`, e.message);
      }
    }

    if (buffers.length === 0) return res.status(500).json({ error: 'Failed to retrieve scan images for re-analysis.' });

    const pipelineResult = await runPipeline(buffers);
    const normalized = pipelineResult.normalized;
    const extractedFields = normalized.fields;
    const { observations, summary } = await runRuleEngine(extractedFields);

    // Update scan with new analysis
    const updates = {
      ocr_raw: normalized.fallback_raw || normalized.gemini_raw || { full_text: extractedFields.raw_text, avg_confidence: normalized.confidence },
      extracted_fields: extractedFields,
      observations,
      summary,
      ocr_engine: pipelineResult.pipeline.engine_used,
      ocr_status: normalized.status,
      ocr_confidence: normalized.confidence,
      ocr_attempts: pipelineResult.pipeline,
      ocr_warnings: normalized.warnings,
      field_conflicts: normalized.field_conflicts || pipelineResult.pipeline.conflicts || [],
      gemini_raw_response: normalized.gemini_raw || null,
      fallback_ocr_response: normalized.fallback_raw || null,
      analysis_metadata: normalized.analysis_metadata,
      normalized_ocr: normalized,
      language_detected: normalized.language_detected,
      evidence: normalized.evidence,
    };

    let updateError = null;
    const { data: updated, error: err } = await supabase.from('scans').update(updates).eq('id', req.params.id).select().single();
    updateError = err;
    if (err) {
      // Fallback if new columns not migrated
      const legacyUpdates = {
        ocr_raw: updates.ocr_raw,
        extracted_fields: updates.extracted_fields,
        observations: updates.observations,
        summary: updates.summary,
      };
      const { data: updated2, error: err2 } = await supabase.from('scans').update(legacyUpdates).eq('id', req.params.id).select().single();
      if (err2) throw err2;
      return res.json({ ...updated2, ocr_engine: updates.ocr_engine, _warning: 'Extended columns not migrated' });
    }

    res.json({
      success: true,
      scan_id: scan.id,
      ocr: {
        primary_engine: pipelineResult.pipeline.engine_used,
        fallback_used: pipelineResult.pipeline.fallback_used,
        confidence: normalized.confidence,
        warnings: normalized.warnings,
      },
      analysis: {
        fields: extractedFields,
        observations,
        evidence: normalized.evidence,
      },
      scan: updated,
    });
  } catch (err) {
    console.error(err);
    const userMsg = err.info?.user_message || err.message || 'Re-analysis failed.';
    res.status(500).json({ error: userMsg });
  }
});

// ---------------------------------------------------------------------
// GET /api/scans  - list / search scans
// ---------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { q, status, limit } = req.query;
    let query = supabase.from('scans').select('*').order('created_at', { ascending: false }).limit(Number(limit) || 100);
    if (status) query = query.eq('status', status);
    const { data: results, error } = await query;
    if (error) throw error;

    // Simple in-memory text search across filename + commodity name +
    // manufacturer (Supabase/Postgres is fine for this PoC but doesn't provide
    // the same dedicated full-text search workflow as a search service).
    let filtered = results;
    if (q) {
      const needle = q.toLowerCase();
      filtered = results.filter((s) => {
        const f = s.corrected_fields || s.extracted_fields || {};
        const haystack = [s.original_filename, f.commodity_name, f.manufacturer_name, s.id, s.ocr_engine, (s.language_detected || []).join(' ')]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(needle);
      });
    }

    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list scans.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/scans/:id
// ---------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('scans').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Scan not found.' });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scan.' });
  }
});

// ---------------------------------------------------------------------
// PATCH /api/scans/:id/fields  - human correction of extracted fields.
// Re-runs the rule engine against the corrected fields and stores a
// correction-history entry (never overwrites the original OCR output).
// ---------------------------------------------------------------------
router.patch('/:id/fields', async (req, res) => {
  try {
    const { data: scan, error: fetchError } = await supabase
      .from('scans')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });
    const previousFields = scan.corrected_fields || scan.extracted_fields;
    const newFields = { ...previousFields, ...req.body.fields };

    const { observations, summary } = await runRuleEngine(newFields);

    const correctionEntry = {
      corrected_by: req.user.uid,
      corrected_by_email: req.user.email,
      corrected_at: new Date().toISOString(),
      previous_fields: previousFields,
      new_fields: newFields,
    };

    const { data: updated, error: updateError } = await supabase
      .from('scans')
      .update({
      corrected_fields: newFields,
      observations,
      summary,
      correction_history: [...(scan.correction_history || []), correctionEntry],
      status: 'corrected',
      })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw updateError;
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save correction.' });
  }
});

// ---------------------------------------------------------------------
// POST /api/scans/:id/review  - human review decision (Section 3 of report)
// ---------------------------------------------------------------------
router.post('/:id/review', async (req, res) => {
  try {
    const { decision, notes } = req.body; // decision: free text chosen by inspector, e.g. "Cleared" / "Escalated for inspection" / "Needs re-labelling check"
    if (!decision) return res.status(400).json({ error: 'A review decision is required.' });

    const { data: scan, error: fetchError } = await supabase
      .from('scans')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });

    const humanReview = {
      reviewed: true,
      reviewer_uid: req.user.uid,
      reviewer_email: req.user.email,
      reviewer_name: req.user.name,
      reviewed_at: new Date().toISOString(),
      decision,
      notes: notes || null,
    };

    const { data: updated, error: updateError } = await supabase
      .from('scans')
      .update({ human_review: humanReview, status: 'reviewed' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (updateError) throw updateError;
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save review.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/scans/:id/report.pdf  - generate + stream the PDF report
// ---------------------------------------------------------------------
router.get('/:id/report.pdf', async (req, res) => {
  try {
    const { data: scan, error } = await supabase.from('scans').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });

    const pdfBuffer = await generateComplianceReportPdf({
      scan,
      extractedFields: scan.corrected_fields || scan.extracted_fields,
      observations: scan.observations,
      summary: scan.summary,
      humanReview: scan.human_review,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-report-${scan.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

module.exports = router;
