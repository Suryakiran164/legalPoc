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
  importer_name?: string;
  packer_name?: string;
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

export type ObservationStatus = 'ok' | 'possible_issue' | 'missing_mandatory_declaration' | 'requires_human_verification' | 'not_found' | 'unreadable' | 'not_applicable' | 'conflicting' | 'verified';

export interface EvidenceItem {
  field: string;
  raw_text: string;
  confidence: number;
  bounding_box?: { x: number; y: number; width: number; height: number };
  image_id?: string;
  engine?: string;
}

export interface NormalizedOcr {
  engine: string;
  confidence: number;
  language_detected?: string[];
  declarations?: any;
  fields?: ExtractedFields & { raw_text?: string };
  evidence?: EvidenceItem[];
  warnings?: string[];
  field_confidences?: Record<string, number>;
  field_statuses?: Record<string, string>;
  conflicts?: any[];
  images?: any[];
  blocks?: any[];
}

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
  storage_path?: string;
  images?: { image_id: string; image_url: string; storage_path: string; originalname?: string; mimetype?: string }[];
  extracted_fields: ExtractedFields;
  corrected_fields: ExtractedFields | null;
  observations: Observation[];
  summary: { total_rules_evaluated: number; ok: number; possible_issues: number; requires_verification: number };
  human_review: { reviewed: boolean; reviewer_name?: string; reviewed_at?: string; decision?: string; notes?: string };
  status: string;
  created_at: string;
  // Gemini pipeline extensions
  ocr_engine?: string;
  ocr_status?: string;
  ocr_confidence?: number | null;
  ocr_attempts?: any;
  ocr_warnings?: string[];
  field_conflicts?: any[];
  gemini_raw_response?: any;
  fallback_ocr_response?: any;
  analysis_metadata?: any;
  normalized_ocr?: NormalizedOcr;
  language_detected?: string[];
  evidence?: EvidenceItem[];
  uncertain_regions?: any[];
  // New API envelope (optional)
  ocr?: { primary_engine: string; fallback_used: boolean; confidence: number; warnings?: string[] };
  correction_history?: any[];
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
