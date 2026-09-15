/**
 * Talks to the Python OCR microservice (EasyOCR) and normalizes its raw
 * text-block output into the structured "extracted fields" shape the rule
 * engine expects. The field-extraction here is heuristic (regex/keyword
 * based) - good enough for a PoC, explicitly NOT a substitute for a real
 * NLP field extractor.
 */
const axios = require('axios');
const FormData = require('form-data');

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
  const fullText = ocrResult.full_text || '';
  const lower = fullText.toLowerCase();

  const fields = {
    package_type: 'retail_package',
    ocr_confidence: ocrResult.avg_confidence ?? null,
    raw_text: fullText,
  };

  // --- Manufacturer / packer / importer ---
  const mfgMatch = fullText.match(/(?:Mfd|Manufactured|Packed|Marketed)\s*(?:by|By)\s*[:\-]?\s*([^\n]+)/i);
  if (mfgMatch) fields.manufacturer_name = mfgMatch[1].trim().slice(0, 200);
  const addressMatch = fullText.match(/Address\s*[:\-]?\s*([^\n]+)/i);
  if (addressMatch) fields.manufacturer_address = addressMatch[1].trim().slice(0, 300);
  else if (mfgMatch && mfgMatch[1].length > 25) fields.manufacturer_address = mfgMatch[1].trim();

  // --- Country of origin ---
  fields.is_imported = /country of origin|imported by|imported from/i.test(fullText);
  const originMatch = fullText.match(/Country of Origin\s*[:\-]?\s*([A-Za-z ]+)/i);
  if (originMatch) fields.country_of_origin = originMatch[1].trim();

  // --- Commodity / generic name --- (first substantial line as a heuristic)
  const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length) fields.commodity_name = lines[0].slice(0, 150);

  // --- Net quantity ---
  const qtyMatch = fullText.match(/Net\s*(?:Qty|Quantity|Wt|Weight|Vol|Volume)?\s*[:\-]?\s*([\d.,]+)\s*(kg|g|gm|gms|ml|l|litre|litres|nos|pcs|pieces)/i);
  if (qtyMatch) {
    fields.net_quantity_value = qtyMatch[1];
    fields.net_quantity_unit = qtyMatch[2].toLowerCase();
  }

  // --- Manufacture date ---
  const mfgDateMatch = fullText.match(/(?:Mfg|Manufactured|Mfd|Pkd)\.?\s*(?:Date|Dt|On)?\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}[\/\-]\d{4}|[A-Za-z]{3,9}\s*\d{4})/i);
  if (mfgDateMatch) fields.mfg_date = mfgDateMatch[1].trim();

  // --- Best before / expiry ---
  const bbMatch = fullText.match(/(?:Best Before|Use By|Expiry|Exp\.?)\s*(?:Date)?\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}[\/\-]\d{4}|[A-Za-z]{3,9}\s*\d{4}|\d+\s*months? from (?:mfg|packaging))/i);
  if (bbMatch) fields.best_before_date = bbMatch[1].trim();

  // --- MRP ---
  const mrpMatch = fullText.match(/(?:MRP|M\.R\.P\.?|Maximum Retail Price)\s*[:\-]?\s*([^\n]{0,60})/i);
  if (mrpMatch) fields.mrp_raw = mrpMatch[1].trim();

  // --- Unit sale price ---
  const uspMatch = fullText.match(/(?:Unit Sale Price|USP|Price per\s*[a-zA-Z]+)\s*[:\-]?\s*([^\n]{0,60})/i);
  if (uspMatch) fields.unit_sale_price_raw = uspMatch[1].trim();

  // --- Consumer care ---
  const careNameMatch = fullText.match(/(?:Consumer Care|Customer Care)\s*[:\-]?\s*([^\n]{0,80})/i);
  if (careNameMatch) fields.consumer_care_name = careNameMatch[1].trim();
  const phoneMatch = fullText.match(/(\+?\d[\d\-\s]{7,14}\d)/);
  if (phoneMatch) fields.consumer_care_phone = phoneMatch[1].trim();
  const emailMatch = fullText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) fields.consumer_care_email = emailMatch[0].trim();

  return fields;
}

module.exports = { runOcr, extractFields };
