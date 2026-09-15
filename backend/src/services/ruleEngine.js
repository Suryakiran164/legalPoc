/**
 * Data-driven rule engine.
 *
 * Rules live in Supabase (the "rules" table) using the schema given in
 * the spec (rule_id, title, legal_reference, checks[], severity, etc).
 * This module NEVER hard-codes legal conclusions — every rule fires an
 * "AI Observation" that a human must confirm or override. Nothing here
 * ever emits the words "non-compliant", "violation" or "illegal".
 */

const { supabase } = require('../config/supabase');

// ---- individual check implementations -------------------------------
// Each check receives the normalized extracted-fields object and returns
// { passed: boolean, note?: string }
const CHECKS = {
  manufacturer_field_present: (f) =>
    result(!!f.manufacturer_name && f.manufacturer_name.trim().length > 3),

  manufacturer_address_present: (f) =>
    result(!!f.manufacturer_address && f.manufacturer_address.trim().length > 5),

  country_of_origin_present: (f) =>
    result(!f.is_imported || (!!f.country_of_origin && f.country_of_origin.trim().length > 1)),

  commodity_name_present: (f) =>
    result(!!f.commodity_name && f.commodity_name.trim().length > 1),

  net_quantity_present: (f) => result(!!f.net_quantity_value),

  net_quantity_has_valid_unit: (f) => {
    const VALID_UNITS = ['g', 'kg', 'ml', 'l', 'nos', 'gm', 'gms', 'litre', 'litres', 'pcs', 'pieces'];
    const unit = (f.net_quantity_unit || '').toLowerCase().trim();
    return result(VALID_UNITS.includes(unit), `Detected unit: "${unit || 'none'}"`);
  },

  mfg_date_present: (f) => result(!!f.mfg_date),

  mfg_date_not_future: (f) => {
    if (!f.mfg_date) return result(false, 'No manufacturing date extracted.');
    const d = parseLooseDate(f.mfg_date);
    if (!d) return result(false, 'Manufacturing date could not be parsed.');
    return result(d.getTime() <= Date.now(), `Parsed date: ${d.toDateString()}`);
  },

  best_before_after_mfg: (f) => {
    if (!f.best_before_date) return result(true, 'No best-before date declared (may be exempt).');
    const mfg = parseLooseDate(f.mfg_date);
    const bb = parseLooseDate(f.best_before_date);
    if (!mfg || !bb) return result(false, 'Could not compare dates - parsing failed.');
    return result(bb.getTime() > mfg.getTime());
  },

  mrp_field_present: (f) => result(!!f.mrp_raw),

  mrp_has_currency_indicator: (f) => {
    const raw = (f.mrp_raw || '').toLowerCase();
    return result(/(₹|rs\.?|inr)/i.test(raw));
  },

  mrp_is_numeric: (f) => {
    const raw = f.mrp_raw || '';
    const match = raw.match(/[\d,]+(\.\d{1,2})?/);
    return result(!!match, match ? `Detected amount: ${match[0]}` : undefined);
  },

  mentions_inclusive_of_all_taxes: (f) => {
    const raw = (f.mrp_raw || '').toLowerCase();
    return result(raw.includes('inclusive of all tax') || raw.includes('incl. of all tax') || raw.includes('incl of all tax'));
  },

  consumer_care_name_present: (f) => result(!!f.consumer_care_name),

  consumer_care_contact_present: (f) =>
    result(!!f.consumer_care_phone || !!f.consumer_care_email),

  unit_sale_price_present: (f) => result(!!f.unit_sale_price_raw),

  ocr_confidence_sufficient: (f) =>
    result((f.ocr_confidence ?? 1) >= 0.55, `OCR confidence: ${(f.ocr_confidence ?? 1).toFixed(2)}`),
};

function result(passed, note) {
  return { passed, note };
}

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d;
  // Try MM/YYYY style
  const mmYYYY = String(value).match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (mmYYYY) {
    return new Date(Number(mmYYYY[2]), Number(mmYYYY[1]) - 1, 1);
  }
  return null;
}

/**
 * Loads all active rules from Supabase, ordered by severity (high first).
 */
async function loadActiveRules() {
  const { data: rules, error } = await supabase.from('rules').select('*').eq('status', 'active');
  if (error) throw error;
  const severityOrder = { high: 0, 'medium-high': 1, medium: 2, low: 3 };
  rules.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));
  return rules;
}

/**
 * Runs every applicable rule against the extracted fields and returns an
 * array of AI-observation objects. Never returns a legal verdict - only
 * observations that a human reviewer must confirm.
 */
async function runRuleEngine(extractedFields, options = {}) {
  const rules = options.rules || (await loadActiveRules());
  const applicableType = extractedFields.package_type || 'retail_package';

  const observations = [];

  for (const rule of rules) {
    if (rule.applies_to && !rule.applies_to.includes(applicableType)) continue;

    // Conditional rules that only apply in certain circumstances.
    if (rule.rule_id === 'LMPC-002' && !extractedFields.is_imported) continue;
    if (rule.rule_id === 'LMPC-006' && extractedFields.best_before_exempt) continue;

    const checkResults = (rule.checks || []).map((checkName) => {
      const fn = CHECKS[checkName];
      if (!fn) return { checkName, passed: null, note: 'Unknown check (not implemented).' };
      const r = fn(extractedFields);
      return { checkName, passed: r.passed, note: r.note };
    });

    const allPassed = checkResults.every((c) => c.passed === true);
    const anyUnknown = checkResults.some((c) => c.passed === null);

    let status;
    if (anyUnknown) {
      status = 'requires_human_verification';
    } else if (allPassed) {
      status = 'ok';
    } else {
      status = 'possible_issue';
    }

    // Low OCR confidence downgrades any "ok" into "requires verification"
    // rather than asserting compliance the AI isn't confident about.
    if (status === 'ok' && (extractedFields.ocr_confidence ?? 1) < 0.55) {
      status = 'requires_human_verification';
    }

    observations.push({
      rule_id: rule.rule_id,
      title: rule.title,
      legal_reference: rule.legal_reference,
      severity: rule.severity,
      status, // 'ok' | 'possible_issue' | 'missing_mandatory_declaration' | 'requires_human_verification'
      ai_message:
        status === 'ok'
          ? `AI Observation: ${rule.title} appears present and consistent with the expected format.`
          : status === 'requires_human_verification'
          ? `AI Observation: ${rule.title} could not be confidently assessed and requires human verification.`
          : rule.failure_message || `AI Observation: ${rule.title} appears to be missing or incomplete.`,
      recommendation: status === 'ok' ? null : rule.recommendation || null,
      checks: checkResults,
      requires_human_confirmation: rule.requires_human_confirmation !== false,
    });
  }

  const summary = {
    total_rules_evaluated: observations.length,
    ok: observations.filter((o) => o.status === 'ok').length,
    possible_issues: observations.filter((o) => o.status === 'possible_issue').length,
    requires_verification: observations.filter((o) => o.status === 'requires_human_verification').length,
  };

  return { observations, summary };
}

module.exports = { runRuleEngine, loadActiveRules, CHECKS };
