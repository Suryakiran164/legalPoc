/**
 * Gemini Vision OCR service.
 * Primary OCR + visual understanding engine for Indian packaged-commodity labels.
 *
 * Responsibilities:
 *  - Build structured extraction prompt (multilingual, evidence-aware)
 *  - Call Gemini via Google GenAI API (server-side only)
 *  - Handle timeouts, retries, quota/auth errors
 *  - Parse & validate structured JSON
 *  - Normalize Gemini output to common Normalized OCR interface
 *
 * Never makes legal compliance decisions - only extracts evidence.
 */

const { createEmptyNormalized, declarationsToFlatFields } = require('./normalizedOcr');

// Config from env - model configurable per spec
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '20000', 10);
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '2', 10);
const GEMINI_CONFIDENCE_THRESHOLD = parseFloat(process.env.GEMINI_CONFIDENCE_THRESHOLD || '0.6');

let genAIClient = null;
try {
  // Try new SDK first
  const { GoogleGenAI } = require('@google/genai');
  if (GEMINI_API_KEY) genAIClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
} catch (e) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (GEMINI_API_KEY) genAIClient = new GoogleGenerativeAI(GEMINI_API_KEY);
  } catch (e2) {
    // No SDK installed - will use raw fetch fallback
    genAIClient = null;
  }
}

const GEMINI_PROMPT = `You are an expert OCR + vision assistant for Indian packaged commodity labels under the Legal Metrology (Packaged Commodities) Rules, 2011.

Analyze the provided package image(s) as EVIDENCE EXTRACTION ONLY. You are NOT to decide legal compliance. Extract what is visibly printed.

For each image, extract structured data. Return STRICT JSON ONLY, no markdown, no explanation, following this exact schema:

{
  "engine": "gemini",
  "status": "success",
  "language_detected": ["en", "hi"],
  "product": {
    "name": {"value": "", "raw_text": "", "confidence": 0},
    "category": {"value": "", "confidence": 0}
  },
  "declarations": {
    "manufacturer": {"name": "", "address": "", "raw_text": "", "confidence": 0, "status": "verified|not_found|unreadable|not_applicable|conflicting|requires_human_verification"},
    "packer": {"name": "", "address": "", "raw_text": "", "confidence": 0, "status": ""},
    "importer": {"name": "", "address": "", "raw_text": "", "confidence": 0, "status": ""},
    "country_of_origin": {"value": "", "raw_text": "", "confidence": 0, "status": ""},
    "net_quantity": {"value": null, "unit": "", "raw_text": "", "confidence": 0, "status": ""},
    "mrp": {"value": null, "raw_text": "", "confidence": 0, "status": ""},
    "manufacture_or_packing_date": {"value": "", "raw_text": "", "confidence": 0, "status": ""},
    "best_before_or_use_by": {"value": "", "raw_text": "", "confidence": 0, "status": ""},
    "consumer_care": {"phone": "", "email": "", "address": "", "raw_text": "", "confidence": 0, "status": ""},
    "unit_sale_price": {"value": null, "unit": "", "raw_text": "", "confidence": 0, "status": ""}
  },
  "evidence": [
    {"field": "mrp", "raw_text": "MRP ₹199", "confidence": 0.97, "bounding_box": {"x":0,"y":0,"width":0,"height":0}, "image_id": "img_0"}
  ],
  "warnings": [],
  "uncertain_regions": []
}

RULES:
- For missing fields return null and status "not_found". NEVER invent values.
- If text is visible but unreadable (blur, glare, crop), use status "unreadable" and confidence <0.4.
- If field is not applicable (e.g., country_of_origin for domestic product), use status "not_applicable".
- If multiple values conflict across regions/images, use status "conflicting" and list in warnings.
- Preserve exact raw_text as printed, including language. Also provide normalized value.
- Detect languages: en, hi, kn, ta, te, ml, mr, bn, gu, pa, etc.
- Handle ₹ / Rs / INR variants, Indian number formatting (1,00,000), kg vs g vs ml vs L, decimal quantities.
- Detect MRP variants: "MRP", "M.R.P.", "Maximum Retail Price", sticker MRP, overprinted MRP, covered/duplicated declarations.
- Detect stickers, overprints, barcode/QR, batch/lot.
- Provide evidence with raw_text + confidence per field where possible. Bounding boxes can be 0 if not precise.
- Languages: normalize internally but keep raw_text in original script (e.g., "अधिकतम खुदरा मूल्य ₹99" -> raw_text keeps Hindi, normalized value 99).
- Confidence must be field-level 0..1. Be conservative when unsure.
- Return warnings for: glare, blur, low resolution, rotated, curved bottle, wrinkled, sticker-over-sticker, duplicate declarations, conflicting MRPs, future mfg date, etc.
`;

function buildGeminiPayload(imagesWithMime) {
  // imagesWithMime: [{ buffer, mimetype, image_id }]
  const parts = [{ text: GEMINI_PROMPT }];
  for (const img of imagesWithMime) {
    const base64 = img.buffer.toString('base64');
    parts.push({
      inlineData: {
        mimeType: img.mimetype || 'image/jpeg',
        data: base64,
      },
    });
  }
  return parts;
}

async function callGeminiWithFetch(imagesWithMime, opts = {}) {
  const timeoutMs = opts.timeoutMs || GEMINI_TIMEOUT_MS;
  const model = opts.model || GEMINI_MODEL;

  if (!GEMINI_API_KEY) {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { code: 'MISSING_API_KEY', retryable: false });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  const parts = buildGeminiPayload(imagesWithMime);

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let code = 'GEMINI_API_ERROR';
      let retryable = false;
      if (resp.status === 429) { code = 'QUOTA_EXCEEDED'; retryable = true; }
      else if (resp.status === 408 || resp.status === 502 || resp.status === 503 || resp.status === 504) { code = 'TRANSIENT_ERROR'; retryable = true; }
      else if (resp.status === 400) { code = 'BAD_REQUEST'; retryable = false; }
      else if (resp.status === 401 || resp.status === 403) { code = 'AUTH_ERROR'; retryable = false; }
      const err = new Error(`Gemini API error ${resp.status}: ${text.slice(0, 500)}`);
      err.code = code;
      err.status = resp.status;
      err.retryable = retryable;
      throw err;
    }

    const data = await resp.json();

    // Extract text content
    const candidate = data.candidates?.[0];
    const textPart = candidate?.content?.parts?.[0]?.text;
    if (!textPart) {
      throw Object.assign(new Error('Gemini returned no text content'), { code: 'EMPTY_RESPONSE', retryable: true });
    }
    return { rawResponse: data, text: textPart, usage: data.usageMetadata };
  } finally {
    clearTimeout(timeout);
  }
}

async function callGeminiWithSdk(imagesWithMime, opts = {}) {
  const timeoutMs = opts.timeoutMs || GEMINI_TIMEOUT_MS;
  const model = opts.model || GEMINI_MODEL;

  if (!genAIClient) throw Object.assign(new Error('GenAI SDK not available'), { code: 'SDK_MISSING', retryable: false });

  // Detect which SDK shape we have
  const isNewSdk = !!genAIClient.models;

  const parts = buildGeminiPayload(imagesWithMime);

  // Wrap in timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (isNewSdk) {
      // @google/genai - new SDK
      const result = await genAIClient.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      });
      const text = result.text || result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw Object.assign(new Error('Gemini SDK returned empty text'), { code: 'EMPTY_RESPONSE', retryable: true });
      return { rawResponse: result, text, usage: result.usageMetadata };
    } else {
      // @google/generative-ai old SDK
      const mdl = genAIClient.getGenerativeModel({ model, generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' } });
      // Convert parts to SDK format
      const sdkParts = parts.map(p => {
        if (p.text) return { text: p.text };
        if (p.inlineData) return { inlineData: p.inlineData };
        return p;
      });
      const result = await mdl.generateContent(sdkParts);
      const response = await result.response;
      const text = response.text();
      if (!text) throw Object.assign(new Error('Gemini SDK returned empty text'), { code: 'EMPTY_RESPONSE', retryable: true });
      return { rawResponse: response, text, usage: response.usageMetadata };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function parseGeminiJson(text) {
  if (!text) throw Object.assign(new Error('Empty Gemini response'), { code: 'EMPTY_RESPONSE', retryable: false });
  let cleaned = text.trim();
  // Strip markdown fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to extract first JSON object
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      const slice = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(slice);
      } catch (e2) {
        throw Object.assign(new Error(`Gemini returned invalid JSON: ${e2.message}. Raw: ${cleaned.slice(0, 500)}`), { code: 'INVALID_JSON', retryable: false, raw: cleaned });
      }
    }
    throw Object.assign(new Error(`Gemini returned invalid JSON: ${e.message}. Raw: ${cleaned.slice(0, 500)}`), { code: 'INVALID_JSON', retryable: false, raw: cleaned });
  }
}

function sanitizeGeminiOutput(parsed) {
  // Ensure required top-level fields exist, coerce types
  if (!parsed || typeof parsed !== 'object') throw Object.assign(new Error('Gemini output not an object'), { code: 'INVALID_SCHEMA', retryable: false });

  // Coerce and validate declarations structure
  const decl = parsed.declarations || {};
  // Normalize confidence values to 0..1
  function normConf(c) {
    let n = Number(c);
    if (isNaN(n)) return 0;
    if (n > 1 && n <= 100) n = n / 100; // handle 0-100 scale
    return Math.max(0, Math.min(1, n));
  }

  // Ensure each declaration has expected shape
  const ensureDecl = (obj, defaults) => {
    if (!obj || typeof obj !== 'object') return defaults;
    return {
      ...defaults,
      ...obj,
      confidence: normConf(obj.confidence ?? defaults.confidence ?? 0),
      status: obj.status || defaults.status || 'not_found',
    };
  };

  const sanitizedDeclarations = {
    manufacturer: ensureDecl(decl.manufacturer, { name: null, address: null, raw_text: null, confidence: 0, status: 'not_found' }),
    packer: ensureDecl(decl.packer, { name: null, address: null, raw_text: null, confidence: 0, status: 'not_found' }),
    importer: ensureDecl(decl.importer, { name: null, address: null, raw_text: null, confidence: 0, status: 'not_found' }),
    country_of_origin: ensureDecl(decl.country_of_origin, { value: null, raw_text: null, confidence: 0, status: 'not_found' }),
    net_quantity: ensureDecl(decl.net_quantity, { value: null, unit: null, raw_text: null, confidence: 0, status: 'not_found' }),
    mrp: ensureDecl(decl.mrp, { value: null, raw_text: null, confidence: 0, status: 'not_found' }),
    manufacture_or_packing_date: ensureDecl(decl.manufacture_or_packing_date, { value: null, raw_text: null, confidence: 0, status: 'not_found' }),
    best_before_or_use_by: ensureDecl(decl.best_before_or_use_by, { value: null, raw_text: null, confidence: 0, status: 'not_found' }),
    consumer_care: ensureDecl(decl.consumer_care, { phone: null, email: null, address: null, raw_text: null, confidence: 0, status: 'not_found' }),
    unit_sale_price: ensureDecl(decl.unit_sale_price, { value: null, unit: null, raw_text: null, confidence: 0, status: 'not_found' }),
  };

  // Languages
  let langs = parsed.language_detected || parsed.languages || ['en'];
  if (!Array.isArray(langs)) langs = [String(langs)];
  langs = langs.map(l => String(l).toLowerCase()).filter(Boolean);
  if (langs.length === 0) langs = ['en'];

  // Evidence
  let evidence = parsed.evidence || [];
  if (!Array.isArray(evidence)) evidence = [];
  evidence = evidence.map(ev => ({
    field: ev.field || 'unknown',
    raw_text: ev.raw_text || '',
    confidence: normConf(ev.confidence ?? 0),
    bounding_box: ev.bounding_box || { x: 0, y: 0, width: 0, height: 0 },
    image_id: ev.image_id || 'img_0',
    engine: 'gemini',
  }));

  // Product
  const product = parsed.product || {};
  const productName = product.name || {};
  const productCategory = product.category || {};

  return {
    engine: 'gemini',
    status: parsed.status || 'success',
    language_detected: langs,
    product: {
      name: {
        value: productName.value || productName.name || null,
        raw_text: productName.raw_text || productName.value || null,
        confidence: normConf(productName.confidence ?? 0),
        status: productName.status || (productName.value ? 'verified' : 'not_found'),
      },
      category: {
        value: productCategory.value || null,
        confidence: normConf(productCategory.confidence ?? 0),
        status: productCategory.status || (productCategory.value ? 'verified' : 'not_found'),
      },
    },
    declarations: sanitizedDeclarations,
    evidence,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    uncertain_regions: Array.isArray(parsed.uncertain_regions) ? parsed.uncertain_regions : [],
    _rawParsed: parsed,
  };
}

function geminiToNormalized(sanitized, opts = {}) {
  const declarations = sanitized.declarations;
  const evidence = sanitized.evidence || [];
  const warnings = sanitized.warnings || [];
  const uncertain = sanitized.uncertain_regions || [];

  // Compute overall confidence as avg of field confidences that are verified
  const confidences = [];
  for (const key of Object.keys(declarations)) {
    const d = declarations[key];
    if (d && typeof d.confidence === 'number' && d.status !== 'not_found' && d.status !== 'not_applicable') {
      confidences.push(d.confidence);
    }
  }
  // Include product name confidence if high
  if (sanitized.product?.name?.confidence) confidences.push(sanitized.product.name.confidence);

  const overallConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

  // Field-level confidences map for ruleEngine threshold checks
  const fieldConfidences = {};
  const fieldStatuses = {};
  // Map declarations to flat confidences
  if (declarations.mrp) fieldConfidences.mrp_raw = declarations.mrp.confidence;
  if (declarations.net_quantity) fieldConfidences.net_quantity_value = declarations.net_quantity.confidence;
  if (declarations.country_of_origin) fieldConfidences.country_of_origin = declarations.country_of_origin.confidence;
  if (declarations.manufacturer) fieldConfidences.manufacturer_name = declarations.manufacturer.confidence;
  if (declarations.manufacture_or_packing_date) fieldConfidences.mfg_date = declarations.manufacture_or_packing_date.confidence;
  if (declarations.best_before_or_use_by) fieldConfidences.best_before_date = declarations.best_before_or_use_by.confidence;
  if (declarations.consumer_care) fieldConfidences.consumer_care_phone = declarations.consumer_care.confidence;

  for (const [k, v] of Object.entries(fieldConfidences)) {
    // Map to status: low confidence -> requires_human_verification
    if (v < 0.55) fieldStatuses[k] = 'requires_human_verification';
    else fieldStatuses[k] = declarations[k]?.status === 'not_found' ? 'not_found' : 'verified';
  }

  // Build flat fields for rule engine
  const flatFields = declarationsToFlatFields(declarations, {
    overallConfidence,
    raw_text: evidence.map(e => e.raw_text).join('\n') || warnings.join('\n'),
    productName: sanitized.product?.name?.value || sanitized.product?.name?.raw_text,
    productCategory: sanitized.product?.category?.value,
  });

  // Status logic
  let status = 'success';
  if (overallConfidence === 0 || confidences.length === 0) status = 'failed';
  else if (overallConfidence < 0.5 || warnings.length > 3) status = 'partial';

  const normalized = createEmptyNormalized({
    engine: 'gemini',
    primary_engine: 'gemini',
    fallback_used: false,
    status,
    confidence: overallConfidence,
    language_detected: sanitized.language_detected,
    product: sanitized.product,
    declarations,
    fields: flatFields,
    field_confidences: fieldConfidences,
    field_statuses: fieldStatuses,
    evidence: evidence.map(ev => ({ ...ev, engine: 'gemini' })),
    warnings: warnings,
    uncertain_regions: uncertain,
    blocks: evidence.map(ev => ({ text: ev.raw_text, confidence: ev.confidence, bbox: ev.bounding_box, engine: 'gemini' })),
    images: opts.images || [],
    gemini_raw: sanitized._rawParsed,
    analysis_metadata: {
      gemini_model: opts.model || GEMINI_MODEL,
      gemini_duration_ms: opts.durationMs || null,
      gemini_attempt: opts.attempt || 1,
    },
  });

  return normalized;
}

async function callGemini(imagesWithMime, opts = {}) {
  const maxRetries = opts.maxRetries ?? GEMINI_MAX_RETRIES;
  const model = opts.model ?? GEMINI_MODEL;
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;

  let lastError = null;
  let attempt = 0;
  let rawResponse = null;
  let text = null;
  let durationMs = 0;

  while (attempt <= maxRetries) {
    attempt += 1;
    const start = Date.now();
    try {
      // Prefer SDK if available and not forced to fetch
      let result;
      if (genAIClient && !opts.forceFetch) {
        try {
          result = await callGeminiWithSdk(imagesWithMime, { model, timeoutMs });
        } catch (sdkErr) {
          // Fallback to fetch on SDK error if not auth/quota
          if (sdkErr.code === 'SDK_MISSING' || sdkErr.message.includes('SDK')) {
            result = await callGeminiWithFetch(imagesWithMime, { model, timeoutMs });
          } else throw sdkErr;
        }
      } else {
        result = await callGeminiWithFetch(imagesWithMime, { model, timeoutMs });
      }
      durationMs = Date.now() - start;
      rawResponse = result.rawResponse;
      text = result.text;
      lastError = null;
      break; // success
    } catch (err) {
      durationMs = Date.now() - start;
      lastError = err;
      lastError.durationMs = durationMs;
      lastError.attempt = attempt;

      // Don't retry on non-retryable errors
      if (err.retryable === false) {
        break;
      }
      // Don't retry auth/quota errors
      if (err.code === 'AUTH_ERROR' || err.code === 'QUOTA_EXCEEDED' || err.code === 'MISSING_API_KEY' || err.code === 'BAD_REQUEST' || err.code === 'INVALID_JSON') {
        if (err.code === 'QUOTA_EXCEEDED' && attempt <= maxRetries) {
          // For quota, wait a bit then retry once
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        break;
      }
      if (attempt > maxRetries) break;
      // Exponential backoff for transient
      const backoff = Math.pow(2, attempt) * 500;
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  if (lastError) {
    const errorInfo = {
      engine: 'gemini',
      status: 'failed',
      error_code: lastError.code || 'UNKNOWN',
      error_message: lastError.message,
      retryable: !!lastError.retryable,
      attempts: attempt,
      duration_ms: lastError.durationMs || durationMs,
      warnings: [lastError.message],
    };
    // For missing API key, we want to trigger fallback silently, not user-facing raw error
    if (lastError.code === 'MISSING_API_KEY') {
      errorInfo.user_message = 'Primary AI extraction is not configured. Using fallback OCR.';
    } else if (lastError.code === 'QUOTA_EXCEEDED') {
      errorInfo.user_message = 'Primary AI extraction quota exceeded. Fallback OCR was used.';
    } else if (lastError.message && lastError.message.includes('abort')) {
      errorInfo.user_message = 'Primary AI extraction timed out. Fallback OCR was used.';
      errorInfo.error_code = 'TIMEOUT';
    } else if (lastError.code === 'INVALID_JSON') {
      errorInfo.user_message = 'Primary AI extraction returned invalid data. Fallback OCR was used.';
    } else {
      errorInfo.user_message = 'Primary AI extraction is currently unavailable. Fallback OCR was used.';
    }
    throw Object.assign(new Error(errorInfo.user_message), { info: errorInfo, originalError: lastError });
  }

  // Parse JSON
  let parsed;
  try {
    parsed = parseGeminiJson(text);
  } catch (parseErr) {
    const errorInfo = {
      engine: 'gemini',
      status: 'failed',
      error_code: parseErr.code || 'INVALID_JSON',
      error_message: parseErr.message,
      raw_text: parseErr.raw || text?.slice(0, 1000),
      attempts: attempt,
      duration_ms: durationMs,
      user_message: 'Primary AI extraction returned invalid data. Fallback OCR was used.',
    };
    throw Object.assign(new Error(errorInfo.user_message), { info: errorInfo, originalError: parseErr });
  }

  let sanitized;
  try {
    sanitized = sanitizeGeminiOutput(parsed);
  } catch (sanitizeErr) {
    throw Object.assign(new Error('Primary AI extraction returned unexpected schema. Fallback OCR was used.'), {
      info: { error_code: 'INVALID_SCHEMA', error_message: sanitizeErr.message, attempts: attempt, duration_ms: durationMs },
      originalError: sanitizeErr,
    });
  }

  const normalized = geminiToNormalized(sanitized, {
    images: imagesWithMime.map((img, i) => ({ image_id: img.image_id || `img_${i}`, mimetype: img.mimetype, size: img.buffer.length })),
    model,
    durationMs,
    attempt,
  });
  normalized.gemini_raw = parsed;
  normalized.analysis_metadata = {
    ...normalized.analysis_metadata,
    gemini_raw_response: rawResponse,
    gemini_text: text,
    duration_ms: durationMs,
    attempts: attempt,
  };

  return normalized;
}

// Public: runGeminiOcr - handles multiple images, maps to normalized
async function runGeminiOcr(imageBuffersWithMeta, opts = {}) {
  // imageBuffersWithMeta: [{ buffer, mimetype, originalname, image_id }]
  if (!GEMINI_API_KEY) {
    throw Object.assign(new Error('Primary AI extraction is not configured. Using fallback OCR.'), {
      info: {
        error_code: 'MISSING_API_KEY',
        error_message: 'GEMINI_API_KEY not set',
        user_message: 'Primary AI extraction is not configured. Using fallback OCR.',
        retryable: false,
      },
    });
  }

  const imagesWithMime = imageBuffersWithMeta.map((img, idx) => ({
    buffer: img.buffer,
    mimetype: img.mimetype || 'image/jpeg',
    image_id: img.image_id || `img_${idx}`,
  }));

  const result = await callGemini(imagesWithMime, opts);
  return result;
}

function getGeminiConfig() {
  return {
    apiKeyConfigured: !!GEMINI_API_KEY,
    model: GEMINI_MODEL,
    timeoutMs: GEMINI_TIMEOUT_MS,
    maxRetries: GEMINI_MAX_RETRIES,
    confidenceThreshold: GEMINI_CONFIDENCE_THRESHOLD,
    sdkAvailable: !!genAIClient,
  };
}

module.exports = {
  runGeminiOcr,
  callGemini,
  parseGeminiJson,
  sanitizeGeminiOutput,
  geminiToNormalized,
  getGeminiConfig,
  GEMINI_PROMPT,
};
