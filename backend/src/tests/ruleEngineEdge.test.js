process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractFields } = require('../services/ocrService');

describe('Edge cases per spec section 13', () => {
  it('missing MRP -> not found status downstream', () => {
    const f = extractFields({ full_text: 'Net Qty 500g\nMfd 01/2024', avg_confidence: 0.9 });
    assert(!f.mrp_raw);
  });
  it('multiple MRP values - extracts first but pipeline should flag conflict', () => {
    const f = extractFields({ full_text: 'MRP ₹199\nMRP ₹189', avg_confidence: 0.9 });
    assert(f.mrp_raw.includes('199')); // first wins, second would be in warnings/conflict handling
  });
  it('decimal quantities', () => {
    const f = extractFields({ full_text: 'Net Quantity: 0.5 kg', avg_confidence: 0.9 });
    assert.equal(f.net_quantity_value, '0.5');
  });
  it('Indian number formatting', () => {
    const f = extractFields({ full_text: 'MRP Rs. 1,00,000', avg_confidence: 0.9 });
    assert(f.mrp_raw.includes('1,00,000'));
  });
  it('future manufacturing date -> rule engine should flag', () => {
    const { CHECKS } = require('../services/ruleEngine');
    const future = new Date(); future.setFullYear(future.getFullYear() + 1);
    const iso = `${future.getMonth() + 1}/${future.getFullYear()}`;
    const f = { mfg_date: iso };
    const res = CHECKS.mfg_date_not_future(f);
    assert.equal(res.passed, false);
  });
  it('best-before before mfg -> fail', () => {
    const { CHECKS } = require('../services/ruleEngine');
    const f = { mfg_date: '01/2025', best_before_date: '01/2024' };
    const res = CHECKS.best_before_after_mfg(f);
    assert.equal(res.passed, false);
  });
  it('imported products missing country -> fail', () => {
    const { CHECKS } = require('../services/ruleEngine');
    const f = { is_imported: true, country_of_origin: '' };
    assert.equal(CHECKS.country_of_origin_present(f).passed, false);
    const f2 = { is_imported: false, country_of_origin: '' };
    assert.equal(CHECKS.country_of_origin_present(f2).passed, true);
  });
  it('consumer care missing contact -> fail', () => {
    const { CHECKS } = require('../services/ruleEngine');
    assert.equal(CHECKS.consumer_care_contact_present({ consumer_care_phone: '', consumer_care_email: '' }).passed, false);
    assert.equal(CHECKS.consumer_care_contact_present({ consumer_care_phone: '18001234' }).passed, true);
  });
  it('promotional price not MRP - avoid false MRP', () => {
    const f = extractFields({ full_text: 'Special Offer Rs 99 only!\nMRP Rs 199', avg_confidence: 0.9 });
    assert(f.mrp_raw.includes('199')); // should pick MRP line, not promo
  });
  it('stylized fonts / very small text -> low confidence handling', () => {
    const f = extractFields({ full_text: 'MRP ??', avg_confidence: 0.3 });
    // Should NOT hallucinate a numeric MRP for unreadable text - either undefined or no digits
    assert(!f.mrp_raw || !/\d/.test(f.mrp_raw));
    // Rule engine should require verification when ocr_confidence low
    const { CHECKS } = require('../services/ruleEngine');
    assert.equal(CHECKS.ocr_confidence_sufficient({ ocr_confidence: 0.3 }).passed, false);
  });
  it('MRP inclusive of taxes check', () => {
    const { CHECKS } = require('../services/ruleEngine');
    assert.equal(CHECKS.mentions_inclusive_of_all_taxes({ mrp_raw: 'MRP ₹199 inclusive of all taxes' }).passed, true);
    assert.equal(CHECKS.mentions_inclusive_of_all_taxes({ mrp_raw: 'MRP ₹199' }).passed, false);
  });
});
