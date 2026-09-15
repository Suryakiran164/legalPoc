import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, Scan, ExtractedFields } from '../api/client';
import StatusPill from '../components/StatusPill';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

const FIELD_LABELS: { key: keyof ExtractedFields; label: string }[] = [
  { key: 'manufacturer_name', label: 'Manufacturer / Packer / Importer' },
  { key: 'manufacturer_address', label: 'Manufacturer Address' },
  { key: 'country_of_origin', label: 'Country of Origin' },
  { key: 'commodity_name', label: 'Commodity Name' },
  { key: 'net_quantity_value', label: 'Net Quantity (value)' },
  { key: 'net_quantity_unit', label: 'Net Quantity (unit)' },
  { key: 'mfg_date', label: 'Manufacture Date' },
  { key: 'best_before_date', label: 'Best Before / Use By' },
  { key: 'mrp_raw', label: 'MRP (as printed)' },
  { key: 'unit_sale_price_raw', label: 'Unit Sale Price' },
  { key: 'consumer_care_name', label: 'Consumer Care Name' },
  { key: 'consumer_care_phone', label: 'Consumer Care Phone' },
  { key: 'consumer_care_email', label: 'Consumer Care Email' },
];

export default function ScanDetail() {
  const { id } = useParams();
  const [scan, setScan] = useState<Scan | null>(null);
  const [formValues, setFormValues] = useState<ExtractedFields>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewDecision, setReviewDecision] = useState('');
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, [id]);

  async function load() {
    try {
      const { data } = await api.get(`/scans/${id}`);
      setScan(data);
      setFormValues(data.corrected_fields || data.extracted_fields || {});
    } catch {
      setError('Could not load this scan.');
    }
  }

  async function saveCorrections() {
    setSaving(true);
    try {
      const { data } = await api.patch(`/scans/${id}/fields`, { fields: formValues });
      setScan(data);
      setEditing(false);
    } catch {
      setError('Could not save corrections.');
    } finally {
      setSaving(false);
    }
  }

  async function submitReview() {
    if (!reviewDecision.trim()) return;
    setReviewing(true);
    try {
      const { data } = await api.post(`/scans/${id}/review`, { decision: reviewDecision, notes: reviewNotes });
      setScan(data);
    } catch {
      setError('Could not save the review decision.');
    } finally {
      setReviewing(false);
    }
  }

  if (error) return <div className="max-w-6xl mx-auto px-5 py-8 text-signal-missing text-sm">{error}</div>;
  if (!scan) return <div className="max-w-6xl mx-auto px-5 py-8 text-sm text-ink/55">Loading…</div>;

  const activeFields = scan.corrected_fields || scan.extracted_fields;

  return (
    <div className="max-w-6xl mx-auto px-5 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">{activeFields.commodity_name || scan.original_filename}</h1>
          <p className="text-xs text-ink/50 font-mono mt-0.5">Scan {scan.id} · {new Date(scan.created_at).toLocaleString('en-IN')}</p>
        </div>
        <a
          href={`${API_BASE}/scans/${scan.id}/report.pdf`}
          className="border border-line px-4 py-2 rounded-sm text-sm font-medium hover:bg-ink hover:text-paper transition-colors"
        >
          Download PDF report
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Image */}
        <div className="border border-line bg-white rounded-sm p-3">
          <p className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">Package Image</p>
          <img src={scan.image_url} alt={scan.original_filename} className="w-full rounded-sm border border-line" />
        </div>

        {/* Extracted / corrected data */}
        <div className="border border-line bg-white rounded-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-ink/50 uppercase tracking-wide">1. OCR Extracted Data {scan.corrected_fields && <span className="text-brass normal-case">(human-corrected)</span>}</p>
            <button onClick={() => setEditing((v) => !v)} className="text-xs font-medium text-brass">
              {editing ? 'Cancel' : 'Correct fields'}
            </button>
          </div>

          <dl className="space-y-2.5">
            {FIELD_LABELS.map(({ key, label }) => (
              <div key={key}>
                <dt className="text-[11px] text-ink/45">{label}</dt>
                {editing ? (
                  <input
                    className="w-full mt-0.5 px-2 py-1 text-sm border border-line rounded-sm focus:outline-none focus:ring-2 focus:ring-brass/40"
                    value={(formValues[key] as string) || ''}
                    onChange={(e) => setFormValues((v) => ({ ...v, [key]: e.target.value }))}
                  />
                ) : (
                  <dd className="text-sm">{(activeFields[key] as string) || <span className="text-ink/35">Not detected</span>}</dd>
                )}
              </div>
            ))}
          </dl>

          {editing && (
            <button onClick={saveCorrections} disabled={saving} className="mt-4 w-full bg-ink text-paper py-2 rounded-sm text-sm font-medium disabled:opacity-60">
              {saving ? 'Saving…' : 'Save corrections & re-run rules'}
            </button>
          )}

          <p className="text-[11px] text-ink/40 mt-3">
            OCR confidence: {activeFields.ocr_confidence != null ? `${Math.round((activeFields.ocr_confidence as number) * 100)}%` : 'N/A'}
          </p>
        </div>

        {/* Rule engine results */}
        <div className="border border-line bg-white rounded-sm p-4">
          <p className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-3">2. Rule Engine Assessment</p>
          <div className="space-y-3 max-h-[560px] overflow-y-auto pr-1">
            {scan.observations.map((obs) => (
              <div key={obs.rule_id} className="border border-line rounded-sm p-3">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-sm font-medium">[{obs.rule_id}] {obs.title}</p>
                </div>
                <StatusPill status={obs.status} />
                <p className="text-[11px] text-ink/45 mt-2 font-mono">{obs.legal_reference}</p>
                <p className="text-xs text-ink/70 mt-1.5">{obs.ai_message}</p>
                {obs.recommendation && <p className="text-xs text-brass mt-1">{obs.recommendation}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Human review */}
      <div className="border border-line bg-white rounded-sm p-5 mt-6">
        <p className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-3">3. Human Review Decision</p>

        {scan.human_review.reviewed ? (
          <div className="text-sm">
            <p><span className="text-ink/50">Reviewed by:</span> {scan.human_review.reviewer_name}</p>
            <p><span className="text-ink/50">Reviewed at:</span> {scan.human_review.reviewed_at && new Date(scan.human_review.reviewed_at).toLocaleString('en-IN')}</p>
            <p><span className="text-ink/50">Decision:</span> {scan.human_review.decision}</p>
            {scan.human_review.notes && <p><span className="text-ink/50">Notes:</span> {scan.human_review.notes}</p>}
          </div>
        ) : (
          <div className="max-w-xl">
            <p className="text-xs text-ink/55 mb-3">
              AI Observations above are not a final compliance determination. Record the inspector's decision below.
            </p>
            <input
              placeholder="Decision (e.g. Cleared, Escalated for physical inspection, Needs re-labelling check)"
              value={reviewDecision}
              onChange={(e) => setReviewDecision(e.target.value)}
              className="w-full mb-2 px-3 py-2 text-sm border border-line rounded-sm focus:outline-none focus:ring-2 focus:ring-brass/40"
            />
            <textarea
              placeholder="Notes (optional)"
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              rows={3}
              className="w-full mb-3 px-3 py-2 text-sm border border-line rounded-sm focus:outline-none focus:ring-2 focus:ring-brass/40"
            />
            <button onClick={submitReview} disabled={reviewing || !reviewDecision.trim()} className="bg-ink text-paper px-4 py-2 rounded-sm text-sm font-medium disabled:opacity-50">
              {reviewing ? 'Saving…' : 'Record review decision'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
