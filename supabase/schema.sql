-- Run this in the Supabase SQL editor before starting the backend.
create table if not exists public.users (
  uid uuid primary key,
  email text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'inspector')),
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.rules (
  rule_id text primary key,
  title text not null,
  legal_reference text not null,
  description text not null,
  severity text not null,
  requires_human_confirmation boolean not null default true,
  applies_to jsonb not null default '[]'::jsonb,
  checks jsonb not null default '[]'::jsonb,
  failure_message text,
  recommendation text,
  status text not null default 'active'
);

create table if not exists public.scans (
  id uuid primary key,
  owner_uid uuid not null references public.users(uid),
  owner_email text not null,
  original_filename text not null,
  image_url text not null,
  storage_path text not null,
  ocr_raw jsonb not null,
  extracted_fields jsonb not null,
  corrected_fields jsonb,
  correction_history jsonb not null default '[]'::jsonb,
  observations jsonb not null,
  summary jsonb not null,
  human_review jsonb not null,
  status text not null,
  created_at timestamptz not null default now(),
  -- Gemini-first pipeline extensions (added incrementally, nullable for backward compat)
  ocr_engine text,
  ocr_status text,
  ocr_confidence double precision,
  ocr_attempts jsonb,
  ocr_warnings jsonb,
  field_conflicts jsonb,
  gemini_raw_response jsonb,
  fallback_ocr_response jsonb,
  analysis_metadata jsonb,
  images jsonb,
  normalized_ocr jsonb
);

create index if not exists scans_created_at_idx on public.scans (created_at desc);
create index if not exists scans_status_idx on public.scans (status);

insert into storage.buckets (id, name, public)
values ('scan-images', 'scan-images', true)
on conflict (id) do nothing;
