# Legal Metrology Packaged Commodities Compliance — PoC

A proof-of-concept web app for checking pre-packaged commodity labels against
a configurable subset of the **Legal Metrology (Packaged Commodities) Rules,
2011**. It OCRs a label image, runs a data-driven rule engine, and surfaces
findings as **AI Observations** — never final legal conclusions — for a human
inspector to confirm, correct, and sign off on.

> **This is a PoC.** It does not issue legal determinations of compliance or
> non-compliance. See [Limitations](#7-poc-limitations) at the end.

---

## 1. Architecture overview

```
┌─────────────────┐      REST (JSON)      ┌──────────────────────┐
│  React Frontend  │ ───────────────────▶ │   Node/Express API    │
│  (Vite + TS +    │ ◀─────────────────── │   (backend/)           │
│   Tailwind)      │                       │                        │
└─────────────────┘                       │  - Auth (JWT)          │
                                           │  - Scans CRUD          │
                                           │  - Rule engine         │
                                           │  - PDF report builder  │
                                           └──────────┬─────────────┘
                                                       │
                                   ┌───────────────────┼─────────────────────┐
                                   ▼                   ▼                     ▼
                          ┌─────────────────┐ ┌────────────────┐  ┌───────────────────┐
                          │ Supabase        │ │ Supabase        │  │ Python OCR service │
                          │ Postgres tables │ │ Storage         │  │ (Flask + EasyOCR)  │
                          │ (users, scans,  │ │ (label images)  │  │  ocr-service/       │
                          │  rules)         │ │                 │  │                     │
                          └─────────────────┘ └────────────────┘  └───────────────────┘
```

**Why a separate OCR microservice?** PaddleOCR/EasyOCR are Python ML
libraries. Rather than shell out from Node, the Express backend calls a small
Flask service over HTTP (`ocr-service/`). This keeps the two runtimes clean
and lets you swap OCR engines without touching the Node backend.

**Why our own JWT auth instead of Supabase Auth on the client?** Simpler to
run entirely from one PoC codebase without extra Supabase dashboard
configuration. The app stores its own user records in Supabase tables and
issues JWTs from the backend, keeping the PoC self-contained.

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
│   │   ├── middleware/          # auth.js (JWT), upload.js (multer)
│   │   ├── routes/              # auth, scans, rules, dashboard
│   │   ├── services/            # ocrService, ruleEngine, pdfService
│   │   ├── utils/validators.js  # password hashing
│   │   ├── scripts/seedRules.js # seeds the 9 LMPC rules into Supabase
│   │   └── server.js
│   ├── package.json
│   └── .env.example
├── ocr-service/                 # Python + Flask + EasyOCR microservice
│   ├── app.py
│   └── requirements.txt
├── frontend/                    # React + TS + Vite + Tailwind
│   └── src/
│       ├── api/client.ts        # axios instance + shared types
│       ├── context/AuthContext.tsx
│       ├── components/          # Navbar, StatusPill, ProtectedRoute
│       └── pages/                # Login, Register, Dashboard, Upload, ScanDetail, ScanHistory
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
# edit .env: set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET, JWT_SECRET, etc.
npm install
npm run seed:rules   # populates the Supabase "rules" table
npm run dev          # http://localhost:5000
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
2. Go to **New Scan**, upload a package label photo.
3. Review the side-by-side OCR data / rule observations, correct any fields,
   record a human review decision, and download the PDF report.

---

## 6. Sample PDF report

The report generated at `GET /api/scans/:id/report.pdf` always has exactly
three sections, matching the compliance workflow:
1. **OCR Extracted Data** — what the OCR engine read off the label.
2. **Rule Engine Assessment (AI Observations)** — each triggered rule with
   its legal reference, status label, and recommendation.
3. **Human Review Decision** — blank/pending until an inspector signs off,
   then shows reviewer, timestamp, decision, and notes.

Generate one by running a scan through the UI and clicking **Download PDF
report** — a fresh report is rendered on each request from the latest scan
state (so it stays a "live" render rather than a stale export).

---

## 7. PoC limitations

- **Field extraction is regex/keyword-based**, not a trained NLP model. It
  works reasonably well on clean, well-lit label photos with conventional
  phrasing ("MRP:", "Net Wt.", "Mfg Date:", etc.) but will miss unusual
  layouts, handwriting, or heavily stylized packaging. This is exactly why
  every result is framed as an "AI Observation" requiring human review.
- **Authentication is PoC-grade**: scrypt password hashing + a single JWT
  secret, two roles (`admin`, `inspector`), no email verification, no
  password reset flow, no rate limiting.
- **No production security hardening**: no request throttling, limited
  input sanitization beyond basic validation, permissive CORS defaults for
  local dev, Storage objects made public for simplicity (swap for signed
  URLs in production).
- **Search** is a simple in-memory substring filter over a bounded recent
  set of scans, not proper full-text search (Supabase/Postgres does not
  provide the same full-text search experience out of the box for this
  PoC — a production build would add Algolia/Typesense/Elasticsearch).
- **OCR runs single-language (English) by default**; multi-language labels
  (e.g. Hindi/regional-language MRP panels, common on Indian packaging)
  would need `easyocr.Reader(['en', 'hi'])` and additional field-extraction
  patterns.
- **Rule coverage** implements the 9 rules specified from Rule 6 plus a
  handful of practical format checks — it is not a complete encoding of the
  entire Legal Metrology (Packaged Commodities) Rules, 2011 and its
  amendments (e.g. commodity-specific exemptions, package-type-specific
  rules for wholesale/industrial packages are out of scope).
- **No legal conclusions, ever.** Every observation is explicitly a
  suggestion for human review; the app is deliberately incapable of
  declaring a product "non-compliant" or "violating" the rules.
