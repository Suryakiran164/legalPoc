/**
 * Normalized OCR interface.
 * Both Gemini and EasyOCR produce data in this shape so the rule engine
 * never needs `if (engine === 'gemini')` checks.
 *
 * Spec reference:
 *  - 11. OCR NORMALIZATION
 *  - 15. CONFIDENCE (field-level)
 *  - 16. EVIDENCE
 *  - 14. IMPORTANT DISTINCTION (status values)
 */

const FIELD_STATUSES = [
  'verified',
  'not_found',
  'unreadable',
  'not_applicable',
  'conflicting',
  'requires_human_verification',
];

/**
 * @typedef {Object} NormalizedField
 * @property {string|null} value - normalized value for rule engine
 * @property {string|null} raw_text - exact text as printed
 * @property {number} confidence - 0..1
 * @property {string} status - one of FIELD_STATUSES
 * @property {string} engine - 'gemini' | 'easyocr' | 'merged'
 * @property {string|null} image_id
 * @property {{x:number,y:number,width:number,height:number}|null} bounding_box
 */

/**
 * Normalized OCR result shape.
 * {
 *   engine: 'gemini'|'easyocr'|'gemini+easyocr'|'fallback',
 *   primary_engine: string,
 *   fallback_used: boolean,
 *   status: 'success'|'partial'|'failed',
 *   confidence: number, // overall 0..1
 *   language_detected: string[],
 *   product: { name, category },
 *   declarations: {}, // structured per spec
 *   fields: {}, // flat legacy fields for ruleEngine compatibility
 *   field_confidences: Record<string,number>,
 *   field_statuses: Record<string,string>,
 *   evidence: Array<Evidence>,
 *   warnings: string[],
 *   uncertain_regions: any[],
 *   conflicts: any[],
 *   blocks: any[],
 *   images: any[],
 *   gemini_raw: any,
 *   fallback_raw: any,
 *   analysis_metadata: {}
 * }
 */

function createEmptyNormalized(overrides = {}) {
  return {
    engine: 'unknown',
    primary_engine: 'unknown',
    fallback_used: false,
    status: 'failed',
    confidence: 0,
    language_detected: ['en'],
    product: {
      name: { value: null, raw_text: null, confidence: 0, status: 'not_found' },
      category: { value: null, confidence: 0, status: 'not_found' },
    },
    declarations: {
      manufacturer: { name: null, address: null, raw_text: null, confidence: 0, status: 'not_found' },
      packer: { name: null, address: null, raw_text: null, confidence: 0, status: 'not_found' },
      importer: { name: null, address: null, raw_text: null, confidence: 0, status: 'not_found' },
      country_of_origin: { value: null, raw_text: null, confidence: 0, status: 'not_found' },
      net_quantity: { value: null, unit: null, raw_text: null, confidence: 0, status: 'not_found' },
      mrp: { value: null, raw_text: null, confidence: 0, status: 'not_found' },
      manufacture_or_packing_date: { value: null, raw_text: null, confidence: 0, status: 'not_found' },
      best_before_or_use_by: { value: null, raw_text: null, confidence: 0, status: 'not_found' },
      consumer_care: { phone: null, email: null, address: null, raw_text: null, confidence: 0, status: 'not_found' },
      unit_sale_price: { value: null, unit: null, raw_text: null, confidence: 0, status: 'not_found' },
    },
    // flat legacy compatibility for existing ruleEngine
    fields: {
      package_type: 'retail_package',
      ocr_confidence: null,
      raw_text: '',
    },
    field_confidences: {},
    field_statuses: {},
    evidence: [],
    warnings: [],
    uncertain_regions: [],
    conflicts: [],
    blocks: [],
    images: [],
    gemini_raw: null,
    fallback_raw: null,
    analysis_metadata: {},
    ...overrides,
  };
}

/**
 * Map structured declarations to flat legacy fields used by ruleEngine.js
 * This keeps the deterministic rule engine untouched while feeding it richer data.
 */
function declarationsToFlatFields(declarations, extra = {}) {
  const fields = {
    package_type: 'retail_package',
    ocr_confidence: extra.overallConfidence ?? null,
    raw_text: extra.raw_text || '',
    is_imported: false,
  };

  // Manufacturer / packer / importer
  // Prefer manufacturer, fallback to packer/importer if manufacturer missing
  const manu = declarations.manufacturer || {};
  const packer = declarations.packer || {};
  const importer = declarations.importer || {};

  const primaryEntity = manu.name ? manu : (packer.name ? packer : importer);
  if (primaryEntity.name) fields.manufacturer_name = primaryEntity.name;
  if (primaryEntity.address) fields.manufacturer_address = primaryEntity.address;

  // Keep individual if present
  if (manu.name) fields.manufacturer_name = manu.name;
  if (manu.address) fields.manufacturer_address = manu.address;
  if (packer.name) fields.packer_name = packer.name;
  if (packer.address) fields.packer_address = packer.address;
  if (importer.name) fields.importer_name = importer.name;
  if (importer.address) fields.importer_address = importer.address;

  if (importer.name || importer.address || declarations.country_of_origin?.value) {
    // Will be refined by importer presence, but also check country_of_origin
  }
  fields.is_imported = !!(importer.name || importer.address || (declarations.country_of_origin && declarations.country_of_origin.value));

  // Country of origin
  if (declarations.country_of_origin?.value) {
    fields.country_of_origin = declarations.country_of_origin.value;
  } else if (declarations.country_of_origin?.raw_text) {
    fields.country_of_origin = declarations.country_of_origin.raw_text;
  }

  // Commodity name
  if (extra.productName) fields.commodity_name = extra.productName;
  else if (extra.raw_text) {
    const lines = extra.raw_text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length) fields.commodity_name = lines[0].slice(0, 150);
  }

  // Net quantity
  if (declarations.net_quantity?.value != null) {
    fields.net_quantity_value = String(declarations.net_quantity.value);
    fields.net_quantity_unit = declarations.net_quantity.unit || null;
  } else if (declarations.net_quantity?.raw_text) {
    // Try to parse
    const m = declarations.net_quantity.raw_text.match(/([\d.,]+)\s*(kg|g|gm|gms|ml|l|litre|litres|nos|pcs|pieces)/i);
    if (m) {
      fields.net_quantity_value = m[1];
      fields.net_quantity_unit = m[2].toLowerCase();
    }
  }

  // MRP
  if (declarations.mrp?.raw_text) fields.mrp_raw = declarations.mrp.raw_text;
  else if (declarations.mrp?.value != null) fields.mrp_raw = `₹${declarations.mrp.value}`;

  // Dates
  if (declarations.manufacture_or_packing_date?.value) fields.mfg_date = declarations.manufacture_or_packing_date.value;
  else if (declarations.manufacture_or_packing_date?.raw_text) fields.mfg_date = declarations.manufacture_or_packing_date.raw_text;

  if (declarations.best_before_or_use_by?.value) fields.best_before_date = declarations.best_before_or_use_by.value;
  else if (declarations.best_before_or_use_by?.raw_text) fields.best_before_date = declarations.best_before_or_use_by.raw_text;

  // Unit sale price
  if (declarations.unit_sale_price?.raw_text) fields.unit_sale_price_raw = declarations.unit_sale_price.raw_text;
  else if (declarations.unit_sale_price?.value != null) fields.unit_sale_price_raw = String(declarations.unit_sale_price.value);

  // Consumer care
  if (declarations.consumer_care?.phone) fields.consumer_care_phone = declarations.consumer_care.phone;
  if (declarations.consumer_care?.email) fields.consumer_care_email = declarations.consumer_care.email;
  if (declarations.consumer_care?.address) fields.consumer_care_name = declarations.consumer_care.address; // fallback
  if (declarations.consumer_care?.raw_text && !fields.consumer_care_name) fields.consumer_care_name = declarations.consumer_care.raw_text.slice(0, 80);

  // Preserve raw_text
  fields.raw_text = extra.raw_text || fields.raw_text;

  // Copy confidence fields for ruleEngine's ocr_confidence_sufficient check
  if (extra.overallConfidence != null) fields.ocr_confidence = extra.overallConfidence;

  // Product category if needed
  if (extra.productCategory) fields.product_category = extra.productCategory;

  return fields;
}

/**
 * Validate normalized structure has minimum viable data
 */
function validateNormalized(normalized) {
  const errors = [];
  if (!normalized) errors.push('normalized is null');
  else {
    if (!normalized.declarations) errors.push('missing declarations');
    if (!normalized.fields) errors.push('missing fields');
    if (typeof normalized.confidence !== 'number') errors.push('confidence not a number');
    if (!Array.isArray(normalized.evidence)) errors.push('evidence not array');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Compare two normalized results for dual-OCR verification.
 * Returns conflicts array.
 */
function compareNormalized(geminiNorm, fallbackNorm) {
  const conflicts = [];
  const fieldsToCompare = ['mrp', 'net_quantity', 'country_of_origin', 'manufacture_or_packing_date', 'best_before_or_use_by'];
  // For flat fields
  const flatCompare = [
    { key: 'mrp_raw', decl: 'mrp' },
    { key: 'net_quantity_value', decl: 'net_quantity' },
    { key: 'country_of_origin', decl: 'country_of_origin' },
    { key: 'mfg_date', decl: 'manufacture_or_packing_date' },
    { key: 'best_before_date', decl: 'best_before_or_use_by' },
  ];

  for (const { key, decl } of flatCompare) {
    const gVal = (geminiNorm.fields[key] || '').toString().trim().toLowerCase();
    const fVal = (fallbackNorm.fields[key] || '').toString().trim().toLowerCase();
    if (gVal && fVal && gVal !== fVal) {
      conflicts.push({
        field: decl,
        flat_key: key,
        gemini_value: geminiNorm.fields[key],
        fallback_value: fallbackNorm.fields[key],
        gemini_confidence: geminiNorm.field_confidences?.[key] ?? geminiNorm.declarations?.[decl]?.confidence ?? 0,
        fallback_confidence: fallbackNorm.field_confidences?.[key] ?? fallbackNorm.declarations?.[decl]?.confidence ?? 0,
        resolution: 'human_review_required',
        status: 'conflicting',
      });
    }
  }

  // Also check merged evidence conflicts for quantity/mrp across images already handled elsewhere
  return conflicts;
}

/**
 * Merge multiple image normalized results into one product-level record.
 * If values conflict across images, mark as conflicting.
 */
function mergeMultiImageResults(results, imageMetas) {
  if (!results || results.length === 0) return createEmptyNormalized({ status: 'failed', warnings: ['No images processed'] });
  if (results.length === 1) return results[0];

  // For now: take most confident result as base, but detect conflicts
  const base = { ...results[0] };
  base.images = imageMetas || results.map((r, i) => ({ image_id: `img_${i}`, ...r.images?.[0] }));
  base.evidence = results.flatMap(r => r.evidence || []);
  base.warnings = [...new Set(results.flatMap(r => r.warnings || []))];
  base.blocks = results.flatMap(r => r.blocks || []);

  // Conflict detection for critical fields across images
  const criticalFlatKeys = ['mrp_raw', 'net_quantity_value', 'net_quantity_unit', 'mfg_date', 'best_before_date'];
  const conflicts = [];
  for (const key of criticalFlatKeys) {
    const values = results.map(r => (r.fields[key] || '').toString().trim()).filter(Boolean);
    const unique = [...new Set(values.map(v => v.toLowerCase()))];
    if (unique.length > 1) {
      conflicts.push({
        field: key,
        values,
        image_ids: results.map((_, i) => `img_${i}`),
        status: 'conflicting',
        message: `CONFLICTING_DECLARATION: ${key} differs across images: ${values.join(' vs ')}`,
      });
      // Mark field status as conflicting
      base.field_statuses[key] = 'conflicting';
      base.fields[key] = values[0]; // keep first but flag conflict
      // For declarations, mark relevant
      if (key === 'mrp_raw') base.declarations.mrp.status = 'conflicting';
      if (key.startsWith('net_quantity')) base.declarations.net_quantity.status = 'conflicting';
    }
  }
  base.conflicts = [...(base.conflicts || []), ...conflicts];
  if (conflicts.length > 0) {
    base.warnings.push(`Conflicting declarations across images: ${conflicts.map(c => c.field).join(', ')}`);
    base.status = 'partial';
  }

  // Merge product name: prefer longest/ most confident
  // Language detection union
  base.language_detected = [...new Set(results.flatMap(r => r.language_detected || []))];

  // Overall confidence = average
  base.confidence = results.reduce((sum, r) => sum + (r.confidence || 0), 0) / results.length;
  base.fields.ocr_confidence = base.confidence;

  return base;
}

module.exports = {
  FIELD_STATUSES,
  createEmptyNormalized,
  declarationsToFlatFields,
  validateNormalized,
  compareNormalized,
  mergeMultiImageResults,
};
