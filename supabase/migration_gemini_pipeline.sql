-- Migration: Gemini-first pipeline extensions
-- Run in Supabase SQL editor if you already created the base schema.
-- Safe to re-run (IF NOT EXISTS / conditional).

-- Add new columns to scans if they don't exist
alter table public.scans add column if not exists ocr_engine text;
alter table public.scans add column if not exists ocr_status text;
alter table public.scans add column if not exists ocr_confidence double precision;
alter table public.scans add column if not exists ocr_attempts jsonb;
alter table public.scans add column if not exists ocr_warnings jsonb;
alter table public.scans add column if not exists field_conflicts jsonb;
alter table public.scans add column if not exists gemini_raw_response jsonb;
alter table public.scans add column if not exists fallback_ocr_response jsonb;
alter table public.scans add column if not exists analysis_metadata jsonb;
alter table public.scans add column if not exists images jsonb;
alter table public.scans add column if not exists normalized_ocr jsonb;

-- Optional child table for normalized evidence per field (for production querying)
create table if not exists public.scan_evidence (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  field text not null,
  raw_text text,
  normalized_value text,
  confidence double precision,
  status text,
  engine text,
  image_id text,
  bounding_box jsonb,
  created_at timestamptz not null default now()
);
create index if not exists scan_evidence_scan_id_idx on public.scan_evidence(scan_id);
create index if not exists scan_evidence_field_idx on public.scan_evidence(field);

-- Indexes for new query patterns
create index if not exists scans_ocr_engine_idx on public.scans(ocr_engine);
create index if not exists scans_ocr_status_idx on public.scans(ocr_status);
