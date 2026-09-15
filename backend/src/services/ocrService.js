/**
 * Talks to the Python OCR microservice (EasyOCR) and normalizes its raw
 * text-block output into the structured "extracted fields" shape the rule
 * engine expects. The field-extraction here is heuristic (regex/keyword
 * based) - good enough for a PoC, explicitly NOT a substitute for a real
 * NLP field extractor.
 *
 * Upgraded for Gemini-first pipeline:
 *  - easyOcrToNormalized() converts EasyOCR output to Normalized OCR schema
 *  - extractFields() now handles multilingual + edge cases per spec section 13
 *  - runOcrNormalized() for single image, runOcrForImages() for multi-image
 */
const axios = require('axios');
const FormData = require('form-data');
const { createEmptyNormalized, declarationsToFlatFields } = require('./normalizedOcr');

const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8001';

async function runOcr(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('image', buffer, { filename, contentType: mimetype });

  const { data } = await axios.post(`${OCR_SERVICE_URL}/ocr`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  // data: { blocks: [{ text, confidence, bbox }], full_text, avg_confidence }
  return data;
}

function extractFields(ocrResult) {
  const fullText = ocrResult.full_text || ocrResult.raw_text || '';
  const lower = fullText.toLowerCase();

  const fields = {
    package_type: 'retail_package',
    ocr_confidence: ocrResult.avg_confidence ?? ocrResult.confidence ?? null,
    raw_text: fullText,
  };

  // --- Manufacturer / packer / importer --- (improved multilingual + importer detection)
  // SupportHindi/Marathi variants via transliteration keywords + English anchors
  const mfgPatterns = [
    /(?:Mfd|Manufactured|Packed|Marketed|Mfg\.?|Pkd\.?|Mfr\.?)\s*(?:by|By)?\s*[:\-]?\s*([^\n]+)/i,
    /(?:निर्माता|पैककर्ता|आयातक)\s*[:\-]?\s*([^\n]+)/i, // Hindi keywords
  ];
  for (const pat of mfgPatterns) {
    const m = fullText.match(pat);
    if (m && m[1] && m[1].trim().length > 3) {
      fields.manufacturer_name = m[1].trim().slice(0, 200);
      break;
    }
  }
  const addressPatterns = [
    /Address\s*[:\-]?\s*([^\n]+)/i,
    /पता\s*[:\-]?\s*([^\n]+)/i,
    /(?:Regd\.?\s*Off|Registered Office|Corporate Office)\s*[:\-]?\s*([^\n]+)/i,
  ];
  for (const pat of addressPatterns) {
    const m = fullText.match(pat);
    if (m && m[1]) {
      fields.manufacturer_address = m[1].trim().slice(0, 300);
      break;
    }
  }
  if (!fields.manufacturer_address && fields.manufacturer_name && fields.manufacturer_name.length > 25) {
    fields.manufacturer_address = fields.manufacturer_name;
  }

  // Detect importer specifically
  const importerMatch = fullText.match(/(?:Imported\s*by|Importer\s*[:\-]?\s*([^\n]+))/i);
  if (importerMatch && importerMatch[1]) {
    fields.importer_name = importerMatch[1].trim().slice(0, 200);
  }

  // --- Country of origin ---
  fields.is_imported = /country of origin|imported by|imported from|imported/i.test(fullText);
  const originPatterns = [
    /Country of Origin\s*[:\-]?\s*([A-Za-z ]+)/i,
    /Made in\s+([A-Za-z ]+)/i,
    /Origin\s*[:\-]?\s*([A-Za-z ]+)/i,
  ];
  for (const pat of originPatterns) {
    const m = fullText.match(pat);
    if (m && m[1] && m[1].trim().length > 1) {
      fields.country_of_origin = m[1].trim().slice(0, 80);
      break;
    }
  }

  // --- Commodity / generic name --- (first substantial line as heuristic, skip MRP/date lines)
  const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);
  const filteredLines = lines.filter(l => !/^(mrp|m\.r\.p|net qty|mfg|best before|consumer care)/i.test(l) && l.length > 2);
  if (filteredLines.length) {
    // Prefer longest line that looks like product name (not containing address keywords)
    const candidate = filteredLines.find(l => l.length > 5 && !/address|care|phone|email/i.test(l)) || filteredLines[0];
    fields.commodity_name = candidate.slice(0, 150);
  } else if (lines.length) {
    fields.commodity_name = lines[0].slice(0, 150);
  }

  // --- Net quantity --- (improved: handle Indian formatting, variants, ₹/Rs confusion avoidance)
  // Supports: 500 g, 500g, 1 kg, 1.5 L, 750 ml, 1,00,000 g, 500gm, 250gms, 2 pcs, 1 Nos, Net Vol. 750 ml
  const qtyPatterns = [
    /Net\s*(?:Qty|Quantity|Wt|Weight|Vol|Volume)?\.?\s*[:\-]?\s*([\d.,]+)\s*(kg|g|gm|gms|ml|l|litre|litres|nos|pcs|pieces)\b/i,
    /Net Content\.?\s*[:\-]?\s*([\d.,]+)\s*(kg|g|gm|gms|ml|l|litre|litres)\b/i,
    /Quantity\.?\s*[:\-]?\s*([\d.,]+)\s*(kg|g|gm|gms|ml|l|litre|litres|nos|pcs|pieces)\b/i,
    /Net Wt\.?\s*[:\-]?\s*([\d.,]+)\s*(kg|g|gm|gms|ml|l|litre|litres)\b/i,
    /Net Vol\.?\s*[:\-]?\s*([\d.,]+)\s*(ml|l|litre|litres|kg|g)\b/i,
  ];
  for (const pat of qtyPatterns) {
    const m = fullText.match(pat);
    if (m) {
      // Clean Indian number formatting: remove commas, but keep decimal
      let val = m[1].replace(/,/g, '');
      // Handle "1,00,000" -> 100000
      fields.net_quantity_value = val;
      fields.net_quantity_unit = m[2].toLowerCase();
      break;
    }
  }

  // --- Manufacture date --- (support DD/MM/YYYY, MM/YYYY, Mon YYYY, DD-MM-YY, Hindi months)
  const mfgPatterns2 = [
    /(?:Mfg|Manufactured|Mfd|Pkd|Packed|Mfg\.?Date)\s*(?:Date|Dt|On)?\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}[\/\-]\d{4}|[A-Za-z]{3,9}\s*\d{4})/i,
    /Manufacturing\s*Date\s*[:\-]?\s*([^\n]{0,20})/i,
  ];
  for (const pat of mfgPatterns2) {
    const m = fullText.match(pat);
    if (m && m[1] && m[1].trim().length >= 4) {
      fields.mfg_date = m[1].trim().slice(0, 30);
      break;
    }
  }

  // --- Best before / expiry ---
  const bbPatterns = [
    /(?:Best Before|Use By|Expiry|Exp\.?|Best before|EXP)\s*(?:Date)?\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}[\/\-]\d{4}|[A-Za-z]{3,9}\s*\d{4}|\d+\s*months? from (?:mfg|packaging)|[^\n]{0,30})/i,
  ];
  for (const pat of bbPatterns) {
    const m = fullText.match(pat);
    if (m && m[1] && m[1].trim().length >= 3) {
      const cand = m[1].trim().slice(0, 60);
      // Avoid capturing generic trailing text if it looks like address
      if (!/address|care/i.test(cand)) {
        fields.best_before_date = cand;
        break;
      }
    }
  }

  // --- MRP --- (handle ₹, Rs, Rs., INR, MRP variants, sticker detection, promotional price disambiguation)
  // Prioritize MRP line over generic price lines
  const mrpPatterns = [
    /(?:MRP|M\.R\.P\.?|Maximum Retail Price)\s*(?:\(incl\.? of all taxes?\)|\s*incl\.? of all taxes?)?\s*[:\-]?\s*([^\n]{0,80})/i,
    /Maximum Retail Price\s*[:\-]?\s*([^\n]{0,80})/i,
    /MRP\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  let mrpFound = null;
  for (const pat of mrpPatterns) {
    const m = fullText.match(pat);
    if (m && m[1]) {
      let raw = m[1].trim();
      // If match includes "inclusive of all taxes" separately, keep it
      const incl = fullText.match(/inclusive of all tax(?:es)?/i);
      if (incl && !/inclusive/i.test(raw)) raw += ' ' + incl[0];
      // Filter out obvious non-MRP promotional prices? MRP should have currency indicator
      if (/[₹]|Rs\.?|INR|\d/.test(raw)) {
        mrpFound = raw.slice(0, 80);
        break;
      }
    }
  }
  if (mrpFound) fields.mrp_raw = mrpFound;

  // --- Unit sale price ---
  const uspPatterns = [
    /(?:Unit Sale Price|USP|Price per\s*[a-zA-Z]+)\s*[:\-]?\s*([^\n]{0,80})/i,
    /Per\s*(?:g|kg|ml|l|piece|pc)\s*[:\-]?\s*([₹Rs\d.,\/\s]+)/i,
  ];
  for (const pat of uspPatterns) {
    const m = fullText.match(pat);
    if (m && m[1]) {
      fields.unit_sale_price_raw = m[1].trim().slice(0, 80);
      break;
    }
  }

  // --- Consumer care --- (phone, email, address)
  const carePatterns = [
    /(?:Consumer Care|Customer Care|Consumer Feedback|Customer Support)\s*[:\-]?\s*([^\n]{0,100})/i,
  ];
  for (const pat of carePatterns) {
    const m = fullText.match(pat);
    if (m && m[1]) {
      fields.consumer_care_name = m[1].trim().slice(0, 120);
      break;
    }
  }
  const phonePatterns = [
    /(\+91[\-\s]?\d{10})/,
    /(\b\d{3,4}[\-\s]\d{6,8}\b)/,
    /(\+?\d[\d\-\s]{7,14}\d)/,
  ];
  for (const pat of phonePatterns) {
    const m = fullText.match(pat);
    if (m && m[1]) {
      const phone = m[1].trim();
      // Avoid misclassifying MRP/date numbers as phone
      if (phone.replace(/\D/g, '').length >= 7 && phone.replace(/\D/g, '').length <= 15) {
        fields.consumer_care_phone = phone;
        break;
      }
    }
  }
  const emailMatch = fullText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) fields.consumer_care_email = emailMatch[0].trim();

  // Detect unreadable / covered scenarios via low confidence flag will be handled at pipeline level,
  // but we can add warnings if text coverage is very low already
  if (!fullText || fullText.trim().length < 10) {
    fields._warnings = ['Very little text detected - possible blur, glare, or cropped label'];
  }

  return fields;
}

/**
 * Convert EasyOCR raw output to Normalized OCR schema.
 * @param {object} ocrResult { blocks, full_text, avg_confidence }
 * @param {object} opts { image_id, language_detected, warnings }
 */
function easyOcrToNormalized(ocrResult, opts = {}) {
  const fullText = ocrResult.full_text || '';
  const avgConf = ocrResult.avg_confidence ?? 0;
  const blocks = ocrResult.blocks || [];

  // Build evidence per block
  const evidence = blocks.map((b, idx) => ({
    field: 'unknown', // will be inferred per block if possible
    raw_text: b.text || '',
    confidence: typeof b.confidence === 'number' ? b.confidence : avgConf,
    bounding_box: Array.isArray(b.bbox) ? { x: b.bbox[0]?.[0] || 0, y: b.bbox[0]?.[1] || 0, width: Math.abs((b.bbox[1]?.[0] || 0) - (b.bbox[0]?.[0] || 0)), height: Math.abs((b.bbox[2]?.[1] || 0) - (b.bbox[0]?.[1] || 0)) } : { x: 0, y: 0, width: 0, height: 0 },
    image_id: opts.image_id || 'img_0',
    engine: 'easyocr',
  }));

  // Try to infer field for each evidence block via keyword matching (for UI click-to-evidence)
  const fieldKeywords = {
    mrp: [/mrp|m\.r\.p|maximum retail price/i],
    net_quantity: [/net qty|net quantity|net wt|net weight/i],
    manufacturer: [/manufactured|mfd|packed|marketed|address/i],
    mfg_date: [/mfg|manufactured|pkd|packed/i],
    best_before: [/best before|use by|expiry|exp/i],
    consumer_care: [/consumer care|customer care/i],
    country_of_origin: [/country of origin|imported by|made in/i],
  };
  for (const ev of evidence) {
    for (const [field, patterns] of Object.entries(fieldKeywords)) {
      if (patterns.some(p => p.test(ev.raw_text))) {
        ev.field = field;
        break;
      }
    }
  }

  // Extract flat fields using existing heuristic (upgraded)
  const flatFields = extractFields(ocrResult);
  flatFields.ocr_confidence = avgConf;

  // Build declarations from flat fields for normalized shape (reverse mapping)
  const declarations = {
    manufacturer: {
      name: flatFields.manufacturer_name || null,
      address: flatFields.manufacturer_address || null,
      raw_text: flatFields.manufacturer_name ? `${flatFields.manufacturer_name} ${flatFields.manufacturer_address || ''}`.trim() : null,
      confidence: flatFields.manufacturer_name ? avgConf : 0,
      status: flatFields.manufacturer_name ? (avgConf < 0.55 ? 'requires_human_verification' : 'verified') : 'not_found',
    },
    packer: { name: flatFields.packer_name || null, address: flatFields.packer_address || null, raw_text: null, confidence: 0, status: flatFields.packer_name ? 'verified' : 'not_found' },
    importer: { name: flatFields.importer_name || null, address: flatFields.importer_address || null, raw_text: flatFields.importer_name || null, confidence: flatFields.importer_name ? avgConf : 0, status: flatFields.importer_name ? 'verified' : (flatFields.is_imported ? 'not_found' : 'not_applicable') },
    country_of_origin: {
      value: flatFields.country_of_origin || null,
      raw_text: flatFields.country_of_origin || null,
      confidence: flatFields.country_of_origin ? avgConf : 0,
      status: flatFields.country_of_origin ? 'verified' : (flatFields.is_imported ? 'not_found' : 'not_applicable'),
    },
    net_quantity: {
      value: flatFields.net_quantity_value ? Number(String(flatFields.net_quantity_value).replace(/,/g, '')) : null,
      unit: flatFields.net_quantity_unit || null,
      raw_text: flatFields.net_quantity_value ? `${flatFields.net_quantity_value} ${flatFields.net_quantity_unit || ''}`.trim() : null,
      confidence: flatFields.net_quantity_value ? avgConf : 0,
      status: flatFields.net_quantity_value ? (avgConf < 0.55 ? 'requires_human_verification' : 'verified') : 'not_found',
    },
    mrp: {
      value: (() => {
        if (!flatFields.mrp_raw) return null;
        const m = flatFields.mrp_raw.match(/[\d,]+(?:\.\d{1,2})?/);
        return m ? Number(m[0].replace(/,/g, '')) : null;
      })(),
      raw_text: flatFields.mrp_raw || null,
      confidence: flatFields.mrp_raw ? avgConf : 0,
      status: flatFields.mrp_raw ? (avgConf < 0.55 ? 'requires_human_verification' : 'verified') : 'not_found',
    },
    manufacture_or_packing_date: {
      value: flatFields.mfg_date || null,
      raw_text: flatFields.mfg_date || null,
      confidence: flatFields.mfg_date ? avgConf : 0,
      status: flatFields.mfg_date ? (avgConf < 0.55 ? 'requires_human_verification' : 'verified') : 'not_found',
    },
    best_before_or_use_by: {
      value: flatFields.best_before_date || null,
      raw_text: flatFields.best_before_date || null,
      confidence: flatFields.best_before_date ? avgConf * 0.9 : 0,
      status: flatFields.best_before_date ? 'verified' : 'not_found',
    },
    consumer_care: {
      phone: flatFields.consumer_care_phone || null,
      email: flatFields.consumer_care_email || null,
      address: flatFields.consumer_care_name || null,
      raw_text: [flatFields.consumer_care_name, flatFields.consumer_care_phone, flatFields.consumer_care_email].filter(Boolean).join(' | ') || null,
      confidence: (flatFields.consumer_care_phone || flatFields.consumer_care_email) ? avgConf : 0,
      status: (flatFields.consumer_care_phone || flatFields.consumer_care_email) ? 'verified' : 'not_found',
    },
    unit_sale_price: {
      value: flatFields.unit_sale_price_raw ? (() => { const m = flatFields.unit_sale_price_raw.match(/[\d,]+(?:\.\d{1,2})?/); return m ? Number(m[0].replace(/,/g,'')) : null; })() : null,
      unit: null,
      raw_text: flatFields.unit_sale_price_raw || null,
      confidence: flatFields.unit_sale_price_raw ? avgConf : 0,
      status: flatFields.unit_sale_price_raw ? 'verified' : 'not_found',
    },
  };

  const warnings = opts.warnings || [];
  if (avgConf < 0.4) warnings.push('Very low OCR confidence - image may be blurry, glare, or low resolution');
  if (!fullText || fullText.trim().length < 20) warnings.push('Almost no text detected');
  if (blocks.length === 0) warnings.push('No text blocks detected');

  // Language detection for EasyOCR: currently en only, but add hi if Devanagari characters present
  const language_detected = ['en'];
  if (/[\u0900-\u097F]/.test(fullText)) language_detected.push('hi');
  // Add more Indian scripts detection
  if (/[\u0C80-\u0CFF]/.test(fullText)) language_detected.push('kn'); // Kannada
  if (/[\u0B80-\u0BFF]/.test(fullText)) language_detected.push('ta');
  if (/[\u0C00-\u0C7F]/.test(fullText)) language_detected.push('te');
  if (/[\u0D00-\u0D7F]/.test(fullText)) language_detected.push('ml');

  const overallConfidence = avgConf;

  const field_confidences = {
    manufacturer_name: declarations.manufacturer.confidence,
    country_of_origin: declarations.country_of_origin.confidence,
    net_quantity_value: declarations.net_quantity.confidence,
    mrp_raw: declarations.mrp.confidence,
    mfg_date: declarations.manufacture_or_packing_date.confidence,
    best_before_date: declarations.best_before_or_use_by.confidence,
    consumer_care_phone: declarations.consumer_care.confidence,
  };

  const field_statuses = {};
  for (const [k, v] of Object.entries(declarations)) {
    const flatKey = {
      manufacturer: 'manufacturer_name',
      country_of_origin: 'country_of_origin',
      net_quantity: 'net_quantity_value',
      mrp: 'mrp_raw',
      manufacture_or_packing_date: 'mfg_date',
      best_before_or_use_by: 'best_before_date',
      consumer_care: 'consumer_care_phone',
      unit_sale_price: 'unit_sale_price_raw',
    }[k];
    if (flatKey) field_statuses[flatKey] = v.status;
  }

  const normalized = createEmptyNormalized({
    engine: 'easyocr',
    primary_engine: 'easyocr',
    fallback_used: false,
    status: avgConf > 0.6 ? 'success' : avgConf > 0.3 ? 'partial' : 'failed',
    confidence: overallConfidence,
    language_detected,
    product: {
      name: { value: flatFields.commodity_name || null, raw_text: flatFields.commodity_name || null, confidence: avgConf, status: flatFields.commodity_name ? 'verified' : 'not_found' },
      category: { value: null, confidence: 0, status: 'not_found' },
    },
    declarations,
    fields: flatFields,
    field_confidences: field_confidences,
    field_statuses,
    evidence,
    warnings,
    uncertain_regions: [],
    blocks,
    images: opts.images || [{ image_id: opts.image_id || 'img_0' }],
    fallback_raw: ocrResult,
    analysis_metadata: {
      ocr_service_url: process.env.OCR_SERVICE_URL,
      easyocr_blocks: blocks.length,
    },
  });

  return normalized;
}

async function runOcr(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('image', buffer, { filename, contentType: mimetype });

  const { data } = await axios.post(`${OCR_SERVICE_URL}/ocr`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 60000,
  });

  // data: { blocks: [{ text, confidence, bbox }], full_text, avg_confidence }
  return data;
}

async function runOcrNormalized(buffer, filename, mimetype, opts = {}) {
  const result = await runOcr(buffer, filename, mimetype);
  return easyOcrToNormalized(result, { image_id: opts.image_id || 'img_0', images: opts.images });
}

/**
 * Run OCR for multiple images and merge.
 * Returns single normalized covering all images (early version).
 * For pipeline, we prefer to keep per-image results and let ocrPipeline merge with conflict detection.
 */
async function runOcrForImages(imagesWithMeta, opts = {}) {
  // imagesWithMeta: [{ buffer, originalname, mimetype, image_id }]
  const perImageNorm = [];
  for (const img of imagesWithMeta) {
    try {
      const raw = await runOcr(img.buffer, img.originalname, img.mimetype);
      const norm = easyOcrToNormalized(raw, { image_id: img.image_id });
      perImageNorm.push(norm);
    } catch (e) {
      console.error(`[ocrService] EasyOCR failed for ${img.image_id}:`, e.message);
      const empty = createEmptyNormalized({
        engine: 'easyocr',
        primary_engine: 'easyocr',
        status: 'failed',
        confidence: 0,
        warnings: [e.message],
        images: [{ image_id: img.image_id }],
        fallback_raw: { error: e.message },
      });
      perImageNorm.push(empty);
    }
  }
  return perImageNorm;
}

module.exports = { runOcr, extractFields, easyOcrToNormalized, runOcrNormalized, runOcrForImages };
