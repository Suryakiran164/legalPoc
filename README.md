# Legal Metrology Packaged Commodities Compliance — PoC

A proof-of-concept web app for checking pre-packaged commodity labels against
a configurable subset of the **Legal Metrology (Packaged Commodities) Rules,
2011**. It OCRs a label image, runs a data-driven rule engine, and surfaces
findings as **AI Observations** — never final legal conclusions — for a human
inspector to confirm, correct, and sign off on.

> **This is a PoC.** It does not issue legal determinations of compliance or
> non-compliance. See [Limitations](#7-poc-limitations) at the end.

---

## 1. Architecture overview (Gemini-first)

```
            IMAGE / PRODUCT LABEL (1-8 images)
                     |
                     v
             IMAGE PREPROCESSING (sharp: resize/sharpen/normalize, preserves original)
                     |
                     v
           GEMINI VISION OCR (primary, multimodal, multilingual)
                     |
              success? + reliability score
               /      \
             YES       NO  (timeout, low confidence, missing fields, invalid JSON, quota)
              |         |
              |         v
              |     FALLBACK OCR (EasyOCR via ocr-service/)
              |         |
              \_________/
                     |
                     v
            OCR NORMALIZATION (single interface → {engine, fields, evidence, confidence})
                     |
                     v
         STRUCTURED FIELD EXTRACTION (MRP, net qty, mfg, importer, consumer care, etc.)
                     |
                     v
            PRODUCT CLASSIFICATION
                     |
                     v
             RULE ENGINE (deterministic, Supabase-driven LMPC-001..009)
                     |
                     v
           COMPLIANCE OBSERVATIONS (AI Observation / Possible Issue / Requires Verification)
                     |
                     v
          HUMAN REVIEW / PDF REPORT (inspector is final authority)
```

```
┌─────────────────┐      REST (JSON)      ┌──────────────────────┐
│  React Frontend  │ ───────────────────▶ │   Node/Express API    │
│  (Vite + TS +    │ ◀─────────────────── │   (backend/)           │
│   Tailwind)      │                       │  - Auth (JWT)          │
└─────────────────┘                       │  - Scans CRUD (multi-image) │
                                           │  - Gemini service      │
                                           │  - OCR pipeline (Gemini-first → fallback) │
                                           │  - Rule engine         │
                                           │  - PDF report builder  │
                                           └──────────┬─────────────┘
                                                       │
                                   ┌───────────────────┼─────────────────────┐
                                   ▼                   ▼                     ▼
                          ┌─────────────────┐ ┌────────────────┐  ┌───────────────────┐
                          │ Supabase        │ │ Supabase        │  │ Python OCR service │
                          │ Postgres tables │ │ Storage         │  │ (Flask + EasyOCR)  │
                          │ (users, scans,  │ │ (label images,  │  │  ocr-service/       │
                          │  rules) + new   │ │  multi-image)   │  │  (FALLBACK only)    │
                          │  ocr_* columns  │ │                 │  │                     │
                          └─────────────────┘ └────────────────┘  └───────────────────┘
                                   ▲
                                   │  Gemini Vision API (primary)
                                   │  (https://generativelanguage.googleapis.com)
                                   └───────────────────┘
```

**Gemini = primary multimodal OCR/vision engine. EasyOCR = fallback engine. Rule engine = deterministic evaluation. Human inspector = final review authority.**

**Why a separate OCR microservice?** Still needed as fallback. Gemini handles complex layouts/multilingual, but EasyOCR ensures the system degrades gracefully when Gemini times out, hits quota, or extracts unreliably (see §6 fallback).

**Why our own JWT auth instead of Supabase Auth on the client?** Same as before — simpler self-contained PoC. JWT protects every scan; Supabase service-role stays server-side; signed/private storage URLs can be enabled for production.

---

## 2. Supabase data model

### `users` (doc id = uid)
| Field | Type | Notes |
|---|---|---|
| uid | string | |
| email | string | lowercased, unique |
| name | string | |
| role | string | `admin` \| `inspector` |
| password_hash / password_salt | string | scrypt-based (PoC-level; use bcrypt or Supabase Auth in production) |
| created_at | ISO string | |

### `rules` (doc id = rule_id, e.g. `LMPC-007`)
Matches the schema given in the spec exactly:
```json
{
  "rule_id": "LMPC-007",
  "title": "Maximum Retail Price (MRP) Declaration",
  "legal_reference": "Rule 6(1)(e) of Legal Metrology (Packaged Commodities) Rules, 2011",
  "description": "...",
  "severity": "high",
  "requires_human_confirmation": true,
  "applies_to": ["retail_package"],
  "checks": ["mrp_field_present", "mrp_has_currency_indicator", "mrp_is_numeric", "mentions_inclusive_of_all_taxes"],
  "failure_message": "AI Observation: ...",
  "recommendation": "...",
  "status": "active"
}
```
Seeded via `backend/src/scripts/seedRules.js` (`npm run seed:rules`). Admins
can edit rules live through `PUT /api/rules/:ruleId` — the engine reads rules
at request time, so no redeploy is needed to tweak a rule.

### `scans` (doc id = scan id, a uuid)
| Field | Notes |
|---|---|
| id, owner_uid, owner_email | |
| original_filename, image_url, storage_path | image lives in Supabase Storage |
| ocr_raw | raw OCR service response (blocks, confidence) |
| extracted_fields | heuristically parsed fields (Section 1 of the report) |
| corrected_fields | human-corrected fields, null until first correction |
| correction_history | array of `{corrected_by, corrected_at, previous_fields, new_fields}` |
| observations | array of rule-engine results (Section 2 of the report) |
| summary | `{total_rules_evaluated, ok, possible_issues, requires_verification}` |
| human_review | `{reviewed, reviewer_name, reviewed_at, decision, notes}` (Section 3) |
| status | `awaiting_review` → `corrected` → `reviewed` |
| created_at | ISO string |

---

## 3. Rules implemented (Rule 6, Legal Metrology (Packaged Commodities) Rules, 2011)

| Rule ID | Declaration | Legal reference | Severity |
|---|---|---|---|
| LMPC-001 | Name & address of manufacturer/packer/importer | Rule 6(1)(a) | High |
| LMPC-002 | Country of origin (imported products only) | Rule 6(1)(aa) | High |
| LMPC-003 | Common/generic name of commodity | Rule 6(1)(b) | High |
| LMPC-004 | Net quantity with standard unit | Rule 6(1)(c), 12, 13 | High |
| LMPC-005 | Month & year of manufacture/packing | Rule 6(1)(d) | High |
| LMPC-006 | Best before / use by date | Rule 6 (perishables) | Medium-High |
| LMPC-007 | Maximum Retail Price, inclusive of taxes | Rule 6(1)(e) | High |
| LMPC-008 | Consumer care details | Rule 6(2) | High |
| LMPC-009 | Unit sale price | Rule 6(11), w.e.f. Oct 2022 | High |

Plus practical checks: MRP currency/format validation, net-quantity unit
validation, manufacture date not in the future, best-before after
manufacture date, and low OCR confidence forcing "Requires Human
Verification" instead of a false "OK".

**Output vocabulary is fixed and non-negotiable** across the whole app:
`AI Observation`, `Possible Issue`, `Missing Mandatory Declaration`,
`Requires Human Verification`. The words "non-compliant", "violation", and
"illegal" are never used anywhere in code, UI copy, or the PDF report.

---

## 4. Folder structure

```
legal-metrology-poc/
├── backend/                     # Node + Express API
│   ├── src/
│   │   ├── config/supabase.js   # Supabase client + Storage config
│   │   ├── middleware/          # auth.js (JWT), upload.js (multer, multi-image)
│   │   ├── routes/              # auth, scans (multi-image + pipeline), rules, dashboard
│   │   ├── services/            # ocrService (normalized), ruleEngine, pdfService (OCR section), geminiService, imagePreprocessor, normalizedOcr, ocrPipeline
│   │   ├── utils/validators.js  # password hashing
│   │   ├── scripts/seedRules.js # seeds the 9 LMPC rules into Supabase
│   │   └── server.js
│   ├── package.json
│   └── .env.example
├── ocr-service/                 # Python + Flask + EasyOCR microservice (FALLBACK)
│   ├── app.py
│   └── requirements.txt
├── frontend/                    # React + TS + Vite + Tailwind
│   └── src/
│       ├── api/client.ts        # axios instance + shared types (incl. Scan ocr_* fields)
│       ├── context/AuthContext.tsx
│       ├── components/          # Navbar, StatusPill, ProtectedRoute
│       └── pages/                # Login, Register, Dashboard, Upload (multi-image, stages), ScanDetail (evidence, debug panel), ScanHistory
├── supabase/
│   ├── schema.sql               # base schema + Gemini extensions (ocr_engine, normalized_ocr, images, etc.)
│   └── migration_gemini_pipeline.sql # incremental migration for existing projects
└── README.md
```

---

## 5. Setup

### Prerequisites
- Node.js 18+
- Python 3.9–3.11 (EasyOCR/PyTorch don't yet support the newest Python releases well)
- A Supabase project with **Postgres tables** and **Storage** enabled

### 5.1 Supabase project
1. Create a project at https://supabase.com.
2. Create the required tables: `users`, `rules`, and `scans`.
3. Enable **Storage** and note your bucket name.
4. Copy the project URL and service-role key from Project Settings → API.
5. Add them to `backend/.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### 5.2 Backend
```bash
cd backend
cp .env.example .env
# edit .env: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET, JWT_SECRET,
# and Gemini: GEMINI_API_KEY, GEMINI_MODEL, GEMINI_TIMEOUT_MS, GEMINI_MAX_RETRIES, GEMINI_CONFIDENCE_THRESHOLD
npm install
npm run seed:rules   # populates the Supabase "rules" table
npm run dev          # http://localhost:5000
```

#### Gemini setup (new)

1. Create a Google AI Studio / Cloud project and generate a `GEMINI_API_KEY` at https://aistudio.google.com/app/apikey
2. Set in `backend/.env`:

```
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.5-flash
GEMINI_TIMEOUT_MS=20000
GEMINI_MAX_RETRIES=2
GEMINI_CONFIDENCE_THRESHOLD=0.6
ENABLE_DUAL_OCR=false
OCR_SERVICE_URL=http://localhost:8001
```

- `GEMINI_MODEL` is configurable (e.g. `gemini-3.5-flash`, `gemini-2.0-pro`); no code change needed.
- API key stays server-side — never exposed to React.
- If `GEMINI_API_KEY` is missing, the pipeline automatically uses EasyOCR fallback (log will show `MISSING_API_KEY`).
- Enable `ENABLE_DUAL_OCR=true` to run both engines and flag disagreements as `REQUIRES_HUMAN_VERIFICATION`.

#### Fallback OCR setup
The existing Flask service remains fallback; keep it running even when Gemini is primary:

```bash
cd ocr-service
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py  # http://localhost:8001
```

#### Migration for existing Supabase projects
If you created the DB before the Gemini upgrade, run the new migration:

```bash
# In Supabase SQL editor, run:
supabase/migration_gemini_pipeline.sql
# or re-run the updated supabase/schema.sql (adds IF NOT EXISTS columns: ocr_engine, normalized_ocr, images, etc.)
```

#### Environment variables (backend/.env.example)
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=scan-images
JWT_SECRET=

GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
GEMINI_TIMEOUT_MS=20000
GEMINI_MAX_RETRIES=2
GEMINI_CONFIDENCE_THRESHOLD=0.6
ENABLE_DUAL_OCR=false

OCR_SERVICE_URL=http://localhost:8001
```

### 5.3 OCR microservice
```bash
cd ocr-service
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py         # http://localhost:8001 (first run downloads EasyOCR models, ~100MB)
```

### 5.4 Frontend
```bash
cd frontend
cp .env.example .env  # defaults already point at localhost:5000/api
npm install
npm run dev            # http://localhost:5173
```

### 5.5 Try it
1. Open http://localhost:5173, register an account (defaults to role
   `inspector`; pass `"role": "admin"` in the register payload, or update the
   corresponding row in Supabase, to get rule-editing rights).
2. Go to **New Scan**, drag-and-drop 1–8 images (Front/Back/Side/MRP sticker/Barcode). Watch stages: Uploading → Processing → Gemini OCR → Validating → (Fallback if needed) → Normalizing → Rules.
3. On **Scan Detail**, see: OCR Engine Used (Gemini / EasyOCR / Gemini+EasyOCR), OCR Confidence, Fields requiring verification, Conflicting fields, Evidence thumbnails, Raw vs Normalized text, Rule results, and the Human Review form. Open the Admin/Debug panel for pipeline timings and engine disagreements.
4. Click **Download PDF report** — now includes an OCR Analysis section (primary engine, fallback, confidence, warnings, conflicts, evidence) plus the three classic sections.
5. Optional: set `ENABLE_DUAL_OCR=true` and re-run a scan to see disagreement detection (e.g. MRP ₹199 vs ₹189 → Requires Human Verification).

### 5.6 OCR pipeline in detail
- **Preprocessing** (backend/src/services/imagePreprocessor.js): resize ≤2000px, sharpen/normalize via `sharp` (falls back to passthrough if not installed); original preserved as authoritative evidence.
- **Gemini primary**: multimodal prompt extracts structured JSON (declarations + evidence + warnings + uncertain_regions) with per-field confidence and `status` (`verified`/`not_found`/`unreadable`/`not_applicable`/`conflicting`/`requires_human_verification`). See `geminiService.js` for prompt and `GEMINI_PROMPT`.
- **Reliability scoring**: `geminiScore = textCoverage * fieldCoverage * confidence * schemaValidity * warningsPenalty`. If `< GEMINI_CONFIDENCE_THRESHOLD` (default 0.6) or other unreliable signals (very low confidence, almost no text, mandatory fields missing), fallback triggers.
- **Fallback**: calls existing Python EasyOCR service (`ocr-service/app.py`) for each image, normalizes via `ocrService.easyOcrToNormalized`, merges multi-image results (detects conflicting MRP/net quantity across images).
- **Dual verification** (optional): both engines run, `compareNormalized` flags disagreements; final field marked `conflicting` → `REQUIRES_HUMAN_VERIFICATION`.
- **Normalization**: `normalizedOcr.js` provides a single interface `{engine, fields, evidence, confidence, blocks, images, warnings, field_statuses, conflicts}` so the rule engine never branches on `if (gemini)`.
- **Multilingual**: Gemini detects `language_detected: ["en","hi","kn",...]`; `raw_text` preserves original script (e.g. `"अधिकतम खुदरा मूल्य ₹99"`), normalized `value` is `99`. EasyOCR fallback also detects Devanagari/Kannada/Tamil in `full_text` and sets `language_detected` accordingly.
- **Field extraction** (ocrService.extractFields): improved regex for MRP/Net Qty (Indian formatting, ₹/Rs/INR variants, kg/g/ml/L/nos), manufacture/best-before dates, importer vs manufacturer, consumer care. Handles: missing/multiple MRP, decimal quantities, stickers/overprints, promotional price disambiguation, glare/blur warnings via low confidence.

### 5.7 API changes

Preserved endpoints now support multi-image:

- `POST /api/scans`  (multipart: `image` single or `images` array up to 8) → runs pipeline, returns:

```json
{
  "success": true,
  "scan_id": "...",
  "ocr": { "primary_engine": "gemini", "fallback_used": false, "confidence": 0.94, "warnings": [], "language_detected": ["en","hi"] },
  "analysis": { "fields": {}, "observations": [], "requires_human_verification": [], "evidence": [] },
  "id": "...", "image_url": "...", "images": [], "observations": [], "summary": {}
}
```

- New: `POST /api/scans/:id/analyze` → re-runs pipeline on stored images (downloads from Supabase Storage), updates scan with new OCR metadata, returns `{success, scan_id, ocr, analysis, scan}`.

- Other endpoints unchanged: `GET /api/scans`, `GET /api/scans/:id`, `PATCH /api/scans/:id/fields`, `POST /api/scans/:id/review`, `GET /api/scans/:id/report.pdf` (now includes OCR section).

- Rate limiting: 15 scans/min per user (in-memory); multer limits 10MB/file; MIME allowlist JPEG/PNG/WEBP.

- Troubleshooting `POST /api/scans` errors:

| Error shown | Meaning |
|---|---|
| `Gemini extraction was insufficient. Running fallback OCR.` | Fallback triggered (see debug panel) |
| `Primary AI extraction timed out. Fallback OCR was used.` | GEMINI_TIMEOUT_MS hit |
| `Primary AI extraction is currently unavailable. Fallback OCR was used.` | Gemini 5xx / network |
| `Primary AI extraction quota exceeded. Fallback OCR was used.` | 429 |
| `OCR could not reliably process this image. Please upload a clearer image.` | Both engines failed |

### 5.8 Adding new rules

Same as before: edit Supabase `rules` table (or `seedRules.js`) — fields `rule_id, title, legal_reference, checks[], severity, failure_message, recommendation, applies_to, status`. Engine loads active rules at request time. To add a commodity-specific rule, set `applies_to: ["retail_package", "new_category"]` and add a corresponding `CHECKS` entry in `ruleEngine.js`.

---

## 6. Sample PDF report

The report generated at `GET /api/scans/:id/report.pdf` now has:

- **OCR Analysis** (new): Primary engine (Gemini / EasyOCR / Gemini+EasyOCR), Fallback used, Confidence, Languages, Processing time, Warnings, Conflicts, Evidence samples (first 4), per-field confidence.
- **1. OCR Extracted Data** — with per-field confidence and `conflicting`/`requires_human_verification` badges.
- **2. Rule Engine Assessment (AI Observations)** — unchanged vocabulary, now also shows `checks` detail.
- **3. Human Review Decision** — plus correction history count.

Generate one by running a scan through the UI and clicking **Download PDF
report** — a fresh report is rendered on each request from the latest scan
state (so it stays a "live" render rather than a stale export).

---

## 7. PoC limitations & new capabilities

- **Field extraction is now Gemini + heuristic**: Gemini extracts structured multilingual fields with evidence; EasyOCR+regex is fallback/heuristic. Still, unusually stylized/handwritten packaging may need human verification — every result remains an "AI Observation" requiring human review.
- **Multilingual improved**: Gemini detects en/hi/kn/ta/te/ml/mr/bn/gu/pa; fallback detects Devanagari/Kannada/Tamil in EasyOCR text. Normalized `value` + `raw_text` preserved (e.g. `"अधिकतम खुदरा मूल्य ₹99"` → raw kept, normalized `99`).
- **Multi-image**: one scan = one product, multiple images merged; conflicting MRP/net qty across images flagged as `CONFLICTING_DECLARATION` + human verification.
- **Authentication still PoC-grade**: scrypt hashing + single JWT secret, two roles, no email verification. New: simple in-memory rate limiting (15 scans/min) on AI endpoints.
- **Security**: Gemini key server-side; multer MIME/size limits; JWT protects scans. Storage objects still public for PoC simplicity (swap for signed URLs in prod).
- **Search** still in-memory substring filter; production would add dedicated search.
- **Rule coverage** still 9 LMPC rules plus format checks; not full 2011‑act encoding; new commodity-specific rules can be added per §5.8.
- **No legal conclusions, ever.** Gemini NEVER says "legally compliant/illegal" — it only extracts evidence; rule engine produces observations; human inspector decides.
