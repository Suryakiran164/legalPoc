const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { supabase, storageBucket } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { runOcr, extractFields } = require('../services/ocrService');
const { runRuleEngine } = require('../services/ruleEngine');
const { generateComplianceReportPdf } = require('../services/pdfService');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------
// POST /api/scans  - upload an image, run OCR + rule engine, store result
// ---------------------------------------------------------------------
router.post('/', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: "image").' });

    const scanId = uuidv4();
    const storagePath = `scans/${req.user.uid}/${scanId}-${req.file.originalname}`;

    // 1. Store the original image in Supabase Storage.
    const { error: uploadError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (uploadError) throw uploadError;
    const { data: imageData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
    const imageUrl = imageData.publicUrl;

    // 2. Run OCR via the Python microservice.
    const ocrResult = await runOcr(req.file.buffer, req.file.originalname, req.file.mimetype);

    // 3. Heuristically extract structured fields from the raw OCR text.
    const extractedFields = extractFields(ocrResult);

    // 4. Run the Supabase-driven rule engine against the extracted fields.
    const { observations, summary } = await runRuleEngine(extractedFields);

    // 5. Persist the scan.
    const scanDoc = {
      id: scanId,
      owner_uid: req.user.uid,
      owner_email: req.user.email,
      original_filename: req.file.originalname,
      image_url: imageUrl,
      storage_path: storagePath,
      ocr_raw: ocrResult,
      extracted_fields: extractedFields,
      corrected_fields: null, // filled in when a human edits fields
      observations,
      summary,
      human_review: { reviewed: false },
      status: 'awaiting_review',
      created_at: new Date().toISOString(),
    };
    const { error: insertError } = await supabase.from('scans').insert(scanDoc);
    if (insertError) throw insertError;

    res.status(201).json(scanDoc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Scan processing failed.' });
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
    if (q) {
      const needle = q.toLowerCase();
      results = results.filter((s) => {
        const f = s.corrected_fields || s.extracted_fields || {};
        const haystack = [s.original_filename, f.commodity_name, f.manufacturer_name, s.id]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(needle);
      });
    }

    res.json(results);
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
