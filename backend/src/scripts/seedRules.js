/**
 * Seeds Supabase's "rules" table with the initial LMPC rule set.
 * Run with: npm run seed:rules
 * Safe to re-run - uses set() with the rule_id as document ID (upsert).
 */
require('dotenv').config();
const { supabase } = require('../config/supabase');

const RULES = [
  {
    rule_id: 'LMPC-001',
    title: 'Name & Address of Manufacturer / Packer / Importer',
    legal_reference: 'Rule 6(1)(a) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Every package shall bear the name and complete address of the manufacturer, packer or importer.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['manufacturer_field_present', 'manufacturer_address_present'],
    failure_message: 'AI Observation: Name and/or address of the manufacturer/packer/importer appears missing or incomplete.',
    recommendation: 'Ensure the full legal name and complete postal address of the manufacturer, packer, or importer is printed clearly on the package.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-002',
    title: 'Country of Origin (for imported products)',
    legal_reference: 'Rule 6(1)(aa) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Imported packages shall declare the country of origin, manufacture or assembly.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['country_of_origin_present'],
    failure_message: 'AI Observation: This package appears to be imported but a Country of Origin declaration was not clearly detected.',
    recommendation: 'For imported goods, declare the country of origin/manufacture/assembly clearly on the principal display panel.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-003',
    title: 'Common / Generic Name of Commodity',
    legal_reference: 'Rule 6(1)(b) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Every package shall bear the common or generic name of the commodity contained in it.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['commodity_name_present'],
    failure_message: 'AI Observation: A common/generic commodity name could not be confidently identified.',
    recommendation: 'Print the common/generic name of the commodity prominently on the principal display panel.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-004',
    title: 'Net Quantity (with standard unit)',
    legal_reference: 'Rule 6(1)(c), Rule 12 and Rule 13 of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Every package shall declare the net quantity in terms of standard units of weight, measure or number.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['net_quantity_present', 'net_quantity_has_valid_unit'],
    failure_message: 'AI Observation: Net quantity declaration appears missing, or the unit used does not look like a standard legal unit.',
    recommendation: 'Declare net quantity using standard units (g, kg, ml, l, or count) in the format prescribed under Rule 12/13.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-005',
    title: 'Month & Year of Manufacture / Packing',
    legal_reference: 'Rule 6(1)(d) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Every package shall bear the month and year in which the commodity was manufactured or packed.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['mfg_date_present', 'mfg_date_not_future'],
    failure_message: 'AI Observation: Month/year of manufacture or packing appears missing, or the detected date looks inconsistent (e.g., in the future).',
    recommendation: 'Ensure month and year of manufacture/packing is printed clearly and is a valid past date.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-006',
    title: 'Best Before / Use By Date',
    legal_reference: 'Rule 6 (commodities that become unfit for use after a certain period) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Where a commodity is liable to become unfit for use after a period, the package shall declare the best-before or use-by date.',
    severity: 'medium-high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['best_before_after_mfg'],
    failure_message: 'AI Observation: Best Before/Use By date is either missing, unclear, or does not appear to fall after the manufacturing date.',
    recommendation: 'For perishable/time-sensitive commodities, ensure a clear best-before/use-by date is declared after the manufacturing date.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-007',
    title: 'Maximum Retail Price (MRP) Declaration',
    legal_reference: 'Rule 6(1)(e) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Every package shall bear the maximum retail price inclusive of all taxes in Indian currency.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['mrp_field_present', 'mrp_has_currency_indicator', 'mrp_is_numeric', 'mentions_inclusive_of_all_taxes'],
    failure_message: 'AI Observation: Maximum Retail Price (MRP) declaration appears missing or incomplete.',
    recommendation: "Ensure MRP is clearly declared as 'MRP Rs. XX.XX inclusive of all taxes' or equivalent approved format.",
    status: 'active',
  },
  {
    rule_id: 'LMPC-008',
    title: 'Consumer Care Details',
    legal_reference: 'Rule 6(2) of Legal Metrology (Packaged Commodities) Rules, 2011',
    description: 'Every package shall carry a name, contact number and/or email address of the person/office to be contacted for consumer complaints.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['consumer_care_name_present', 'consumer_care_contact_present'],
    failure_message: 'AI Observation: Consumer care details (name and a phone number or email) do not appear to be declared.',
    recommendation: 'Include a consumer care name along with a telephone number and/or email address on the package.',
    status: 'active',
  },
  {
    rule_id: 'LMPC-009',
    title: 'Unit Sale Price',
    legal_reference: 'Rule 6(11) of Legal Metrology (Packaged Commodities) Rules, 2011 (w.e.f. Oct 2022)',
    description: 'Packages shall, where applicable, declare the unit sale price in the prescribed format.',
    severity: 'high',
    requires_human_confirmation: true,
    applies_to: ['retail_package'],
    checks: ['unit_sale_price_present'],
    failure_message: 'AI Observation: Unit Sale Price declaration does not appear to be present.',
    recommendation: 'Declare unit sale price (price per standard unit) where required under Rule 6(11).',
    status: 'active',
  },
];

async function seed() {
  const { error } = await supabase.from('rules').upsert(RULES, { onConflict: 'rule_id' });
  if (error) throw error;
  console.log(`Seeded ${RULES.length} rules into Supabase.`);
  // Allow graceful exit on Windows (avoid UV_HANDLE_CLOSING assertion)
  // supabase-js keeps a keepalive socket; let event loop drain before exit
  setTimeout(() => process.exit(0), 150);
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  setTimeout(() => process.exit(1), 150);
});
