import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

export const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('lm_token');
  if (token) {
    config.headers.Authorization = 'Bearer ' + token;
  }
  return config;
});

// --- Types shared with the backend's Firestore document shapes ---
export interface ExtractedFields {
  package_type?: string;
  ocr_confidence?: number | null;
  raw_text?: string;
  manufacturer_name?: string;
  manufacturer_address?: string;
  is_imported?: boolean;
  country_of_origin?: string;
  commodity_name?: string;
  net_quantity_value?: string;
  net_quantity_unit?: string;
  mfg_date?: string;
  best_before_date?: string;
  mrp_raw?: string;
  unit_sale_price_raw?: string;
  consumer_care_name?: string;
  consumer_care_phone?: string;
  consumer_care_email?: string;
  [key: string]: unknown;
}

export type ObservationStatus = 'ok' | 'possible_issue' | 'missing_mandatory_declaration' | 'requires_human_verification';

export interface Observation {
  rule_id: string;
  title: string;
  legal_reference: string;
  severity: string;
  status: ObservationStatus;
  ai_message: string;
  recommendation: string | null;
  checks: { checkName: string; passed: boolean | null; note?: string }[];
  requires_human_confirmation: boolean;
}

export interface Scan {
  id: string;
  owner_email: string;
  original_filename: string;
  image_url: string;
  extracted_fields: ExtractedFields;
  corrected_fields: ExtractedFields | null;
  observations: Observation[];
  summary: { total_rules_evaluated: number; ok: number; possible_issues: number; requires_verification: number };
  human_review: { reviewed: boolean; reviewer_name?: string; reviewed_at?: string; decision?: string; notes?: string };
  status: string;
  created_at: string;
}

export interface DashboardSummary {
  total_scans: number;
  scans_reviewed: number;
  scans_pending_review: number;
  total_possible_issues: number;
  total_requires_verification: number;
  recent_activity: {
    id: string; original_filename: string; status: string; created_at: string;
    commodity_name: string | null; possible_issues: number; requires_verification: number;
  }[];
}
