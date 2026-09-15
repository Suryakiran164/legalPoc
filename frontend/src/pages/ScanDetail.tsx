import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, Scan, ExtractedFields } from '../api/client';
import StatusPill from '../components/StatusPill';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

const FIELD_LABELS: { key: keyof ExtractedFields; label: string; confKey?: string }[] = [
  { key: 'manufacturer_name', label: 'Manufacturer / Packer / Importer', confKey: 'manufacturer_name' },
  { key: 'manufacturer_address', label: 'Manufacturer Address', confKey: 'manufacturer_name' },
  { key: 'country_of_origin', label: 'Country of Origin', confKey: 'country_of_origin' },
  { key: 'commodity_name', label: 'Commodity Name' },
  { key: 'net_quantity_value', label: 'Net Quantity (value)', confKey: 'net_quantity_value' },
  { key: 'net_quantity_unit', label: 'Net Quantity (unit)', confKey: 'net_quantity_value' },
  { key: 'mfg_date', label: 'Manufacture Date', confKey: 'mfg_date' },
  { key: 'best_before_date', label: 'Best Before / Use By', confKey: 'best_before_date' },
  { key: 'mrp_raw', label: 'MRP (as printed)', confKey: 'mrp_raw' },
  { key: 'unit_sale_price_raw', label: 'Unit Sale Price' },
  { key: 'consumer_care_name', label: 'Consumer Care Name' },
  { key: 'consumer_care_phone', label: 'Consumer Care Phone', confKey: 'consumer_care_phone' },
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
  const [showRaw, setShowRaw] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

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

  async function reanalyze() {
    setAnalyzing(true);
    setError(null);
    try {
      const { data } = await api.post(`/scans/${id}/analyze`);
      if (data.scan) setScan(data.scan);
      else load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Re-analysis failed.');
    } finally {
      setAnalyzing(false);
    }
  }

  if (error) return <div className="max-w-6xl mx-auto px-5 py-8 text-signal-missing text-sm">{error}</div>;
  if (!scan) return <div className="max-w-6xl mx-auto px-5 py-8 text-sm text-ink/55">Loading…</div>;

  const activeFields = scan.corrected_fields || scan.extracted_fields;
  const ocrEngine = scan.ocr_engine || (scan as any).ocr?.primary_engine || 'unknown';
  const ocrConfidence = (scan.ocr_confidence ?? (scan as any).ocr?.confidence) ?? activeFields.ocr_confidence;
  const fallbackUsed = ((scan.ocr_attempts?.fallback_used ?? (scan as any).ocr?.fallback_used) ?? false) || ocrEngine.includes('fallback') || ocrEngine === 'easyocr';
  const languageDetected = scan.language_detected || scan.normalized_ocr?.language_detected || [];
  const warningsFromMeta = (scan.analysis_metadata as any)?.pipeline?.fallback_reason ? [(scan.analysis_metadata as any).pipeline.fallback_reason] : [];
  const warnings = scan.ocr_warnings || scan.normalized_ocr?.warnings || warningsFromMeta;
  const conflicts = scan.field_conflicts || scan.normalized_ocr?.conflicts || [];
  const evidence = scan.evidence || scan.normalized_ocr?.evidence || [];
  const uncertain = scan.uncertain_regions || (scan.normalized_ocr as any)?.uncertain_regions || [];
  const images = scan.images && scan.images.length ? scan.images : [{ image_url: scan.image_url, storage_path: scan.storage_path, originalname: scan.original_filename, image_id: 'img_0' }];
  const fieldConfidences: Record<string, number> = scan.normalized_ocr?.field_confidences || {};
  const fieldStatuses: Record<string, string> = scan.normalized_ocr?.field_statuses || {};

  const requiresVerification = scan.observations.filter(o => o.status === 'requires_human_verification');
  const conflicting = scan.observations.filter(o => fieldStatuses[o.rule_id] === 'conflicting' || conflicts.some((c: any) => c.field === o.rule_id));

  return (
    <div className="max-w-6xl mx-auto px-5 py-8">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">{activeFields.commodity_name || scan.original_filename}</h1>
          <p className="text-xs text-ink/50 font-mono mt-0.5">Scan {scan.id} · {new Date(scan.created_at).toLocaleString('en-IN')}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <span className="text-xs border border-line px-2 py-1 rounded-sm bg-white">
              OCR Engine: <span className="font-medium">{ocrEngine}</span>
              {fallbackUsed && <span className="text-brass ml-1"> (fallback EasyOCR used)</span>}
            </span>
            <span className="text-xs border border-line px-2 py-1 rounded-sm bg-white">
              Confidence: <span className="font-medium">{ocrConfidence != null ? `${Math.round(ocrConfidence * 100)}%` : 'N/A'}</span>
            </span>
            {languageDetected.length > 0 && <span className="text-xs border border-line px-2 py-1 rounded-sm bg-white">Lang: {languageDetected.join(', ')}</span>}
            <span className="text-xs border border-line px-2 py-1 rounded-sm bg-white">{scan.status}</span>
          </div>
          {fallbackUsed && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-sm mt-2">
              Gemini extraction was insufficient. Running fallback OCR. Review required — check evidence below.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={reanalyze} disabled={analyzing} className="border border-line px-3 py-2 rounded-sm text-xs font-medium hover:bg-paper disabled:opacity-50">
            {analyzing ? 'Re-analyzing...' : 'Re-run analysis'}
          </button>
          <a
            href={`${API_BASE}/scans/${scan.id}/report.pdf`}
            className="border border-ink bg-ink text-paper px-4 py-2 rounded-sm text-sm font-medium hover:bg-slate-900 transition-colors"
          >
            Download PDF report
          </a>
        </div>
      </div>

      {/* Warnings / Conflicts banners */}
      {(warnings.length > 0 || conflicts.length > 0 || requiresVerification.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {requiresVerification.length > 0 && (
            <div className="border border-signal-verify/30 bg-signal-verify/10 rounded-sm p-3">
              <p className="text-xs font-semibold text-signal-verify">Fields requiring verification ({requiresVerification.length})</p>
              <p className="text-xs text-ink/70 mt-1">{requiresVerification.map(o => o.rule_id).join(', ')}</p>
            </div>
          )}
          {conflicts.length > 0 && (
            <div className="border border-signal-issue/30 bg-signal-issue/10 rounded-sm p-3">
              <p className="text-xs font-semibold text-signal-issue">Conflicting fields ({conflicts.length})</p>
              <ul className="text-xs text-ink/70 mt-1 list-disc ml-4">
                {conflicts.slice(0, 3).map((c: any, i: number) => <li key={i}>{c.field || c.flat_key}: {c.gemini_value || ''} vs {c.fallback_value || (c.values?.join(' vs ') || '')} → {c.resolution || c.status}</li>)}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="border border-amber-200 bg-amber-50 rounded-sm p-3">
              <p className="text-xs font-semibold text-amber-800">Warnings</p>
              <ul className="text-xs text-amber-800/80 mt-1 list-disc ml-4">
                {warnings.slice(0, 3).map((w: string, i: number) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Images */}
        <div className="border border-line bg-white rounded-sm p-3 lg:col-span-1">
          <p className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">Package Images ({images.length})</p>
          <div className="space-y-3">
            {images.map((img: any, idx: number) => (
              <div key={img.image_id || idx} className="border border-line rounded-sm p-2">
                <img src={img.image_url} alt={img.originalname || `Image ${idx}`} className="w-full rounded-sm border border-line" />
                <p className="text-[11px] text-ink/50 mt-1 font-mono">{img.originalname || img.image_id} · {img.image_id}</p>
                {img.metadata && <p className="text-[10px] text-ink/40">{img.metadata.operations?.join(', ') || ''}</p>}
              </div>
            ))}
          </div>
          {evidence.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs font-semibold text-ink/50 uppercase tracking-wide mb-2">Evidence ({evidence.length})</p>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {evidence.slice(0, 8).map((ev: any, i: number) => (
                  <div key={i} className="text-xs border border-line rounded-sm p-2 bg-paper">
                    <p className="font-medium">{ev.field} <span className="text-ink/40">· {ev.engine || ocrEngine} · {Math.round((ev.confidence || 0) * 100)}%</span></p>
                    <p className="text-ink/70 truncate">"{ev.raw_text}"</p>
                    <p className="text-[10px] text-ink/40 font-mono">bbox: {ev.bounding_box ? `${JSON.stringify(ev.bounding_box)}` : 'N/A'} · {ev.image_id}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
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
            {FIELD_LABELS.map(({ key, label, confKey }) => {
              const val = activeFields[key] as string;
              const conf = confKey ? fieldConfidences[confKey] : undefined;
              const status = confKey ? fieldStatuses[confKey] : undefined;
              const hasConflict = status === 'conflicting';
              const needVerify = status === 'requires_human_verification' || status === 'unreadable';
              return (
                <div key={key} className={`${hasConflict ? 'bg-signal-issue/10 border border-signal-issue/20 rounded-sm p-1' : needVerify ? 'bg-signal-verify/10 border border-signal-verify/20 rounded-sm p-1' : ''}`}>
                  <dt className="text-[11px] text-ink/45 flex items-center justify-between">
                    <span>{label}</span>
                    {conf != null && <span className={`text-[10px] font-mono ${conf < 0.55 ? 'text-signal-verify' : 'text-ink/40'}`}>{Math.round(conf * 100)}%</span>}
                  </dt>
                  {editing ? (
                    <input
                      className="w-full mt-0.5 px-2 py-1 text-sm border border-line rounded-sm focus:outline-none focus:ring-2 focus:ring-brass/40"
                      value={(formValues[key] as string) || ''}
                      onChange={(e) => setFormValues((v) => ({ ...v, [key]: e.target.value }))}
                    />
                  ) : (
                    <dd className="text-sm flex items-start justify-between">
                      <span>{val || <span className="text-ink/35">Not detected</span>}</span>
                      {status && status !== 'verified' && status !== 'not_found' && <span className={`text-[10px] ml-2 px-1.5 py-0.5 rounded-sm border ${hasConflict ? 'bg-signal-issue/20 border-signal-issue/30 text-signal-issue' : 'bg-signal-verify/20 border-signal-verify/30 text-signal-verify'}`}>{status}</span>}
                    </dd>
                  )}
                  {status === 'conflicting' && <p className="text-[11px] text-signal-issue">Conflicting across images/engines — human review required.</p>}
                </div>
              );
            })}
          </dl>

          {editing && (
            <button onClick={saveCorrections} disabled={saving} className="mt-4 w-full bg-ink text-paper py-2 rounded-sm text-sm font-medium disabled:opacity-60">
              {saving ? 'Saving…' : 'Save corrections & re-run rules'}
            </button>
          )}

          <div className="mt-3 space-y-1">
            <p className="text-[11px] text-ink/40">
              OCR confidence: {activeFields.ocr_confidence != null ? `${Math.round((activeFields.ocr_confidence as number) * 100)}%` : ocrConfidence != null ? `${Math.round(ocrConfidence * 100)}%` : 'N/A'}
              {scan.ocr_engine && ` · Engine: ${scan.ocr_engine}`}
            </p>
            <button onClick={() => setShowRaw(v => !v)} className="text-[11px] text-brass hover:underline">
              {showRaw ? 'Hide raw text' : 'Show raw extracted text'}
            </button>
            {showRaw && (
              <pre className="text-xs bg-paper border border-line p-2 rounded-sm whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">{activeFields.raw_text || scan.normalized_ocr?.fields?.raw_text || 'No raw text available'}</pre>
            )}
            {scan.normalized_ocr && (
              <div className="text-xs mt-2">
                <p className="text-ink/50">Normalized evidence preview:</p>
                <pre className="text-[11px] bg-paper border border-line p-2 rounded-sm whitespace-pre-wrap max-h-48 overflow-y-auto font-mono">{JSON.stringify(scan.normalized_ocr.declarations, null, 2).slice(0, 2000)}</pre>
              </div>
            )}
          </div>
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
                <StatusPill status={obs.status as any} />
                <p className="text-[11px] text-ink/45 mt-2 font-mono">{obs.legal_reference}</p>
                <p className="text-xs text-ink/70 mt-1.5">{obs.ai_message}</p>
                {obs.recommendation && <p className="text-xs text-brass mt-1">{obs.recommendation}</p>}
                {uncertain.length > 0 && <p className="text-[11px] text-ink/40 mt-1">Uncertain regions noted</p>}
              </div>
            ))}
          </div>
          {uncertain.length > 0 && (
            <div className="mt-3 text-xs border border-amber-200 bg-amber-50 p-2 rounded-sm">
              <p className="font-medium text-amber-800">Uncertain regions:</p>
              <ul className="list-disc ml-4 text-amber-800/80">
                {uncertain.slice(0, 3).map((u: any, i: number) => <li key={i}>{typeof u === 'string' ? u : JSON.stringify(u)}</li>)}
              </ul>
            </div>
          )}
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
              AI Observations above are not a final compliance determination. Record the inspector's decision below. Fields marked "Requires Human Verification" or "Conflicting" must be manually checked against the package images.
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

      {/* Admin / Debug panel */}
      <div className="border border-line bg-white rounded-sm p-4 mt-6">
        <button onClick={() => setShowDebug(v => !v)} className="w-full flex items-center justify-between text-xs font-semibold text-ink/60 uppercase tracking-wide">
          <span>Admin / Debug View</span>
          <span className="text-[11px] border border-line px-2 py-1 rounded-sm bg-paper">{showDebug ? 'Hide' : 'Show'}</span>
        </button>
        {showDebug && (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
            <div className="border border-line rounded-sm p-3 bg-paper">
              <p className="font-semibold">Pipeline</p>
              <p>Primary engine: {ocrEngine}</p>
              <p>Fallback used: {String(fallbackUsed)}</p>
              <p>Fallback reason: {(scan.analysis_metadata as any)?.pipeline?.fallback_reason || (scan as any).ocr_attempts?.fallback_reason || 'N/A'}</p>
              <p>Gemini request: {scan.ocr_attempts?.gemini?.duration_ms ?? (scan.analysis_metadata as any)?.pipeline?.gemini?.duration_ms ?? 'N/A'} ms</p>
              <p>Fallback request: {scan.ocr_attempts?.fallback?.duration_ms ?? 'N/A'} ms</p>
              <p>Total pipeline: {(scan.analysis_metadata as any)?.pipeline?.duration_ms ?? 'N/A'} ms</p>
              <p>OCR confidence: {ocrConfidence != null ? Math.round(ocrConfidence * 100) + '%' : 'N/A'}</p>
              <p>Model: {(scan.analysis_metadata as any)?.pipeline?.gemini?.model || (scan as any).analysis_metadata?.gemini_model || 'N/A'}</p>
            </div>
            <div className="border border-line rounded-sm p-3 bg-paper">
              <p className="font-semibold">Extraction</p>
              <p>Fields extracted: {Object.keys(activeFields).filter(k => activeFields[k]).length}/~13</p>
              <p>Requires verification: {requiresVerification.length}</p>
              <p>Conflicts: {conflicts.length}</p>
              <p>Evidence: {evidence.length}</p>
              <p>Warnings: {warnings.length}</p>
              <p>Language: {languageDetected.join(', ') || 'en'}</p>
              <p>Status: {scan.ocr_status || 'unknown'}</p>
            </div>
            <div className="col-span-1 md:col-span-2 border border-line rounded-sm p-3 bg-paper overflow-hidden">
              <p className="font-semibold">Raw pipeline metadata (truncated)</p>
              <pre className="whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-[11px]">{JSON.stringify(scan.analysis_metadata || scan.ocr_attempts || {}, null, 2).slice(0, 3000)}</pre>
            </div>
            {scan.gemini_raw_response && (
              <div className="col-span-1 md:col-span-2 border border-line rounded-sm p-3 bg-paper overflow-hidden">
                <p className="font-semibold">Gemini raw (truncated, keys hidden)</p>
                <pre className="whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-[11px]">{JSON.stringify(scan.gemini_raw_response, null, 2).slice(0, 3000)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
