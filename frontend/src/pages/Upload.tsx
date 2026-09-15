import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

type Stage = 'idle' | 'uploading' | 'processing' | 'gemini' | 'validating' | 'fallback' | 'normalizing' | 'rules' | 'done';

const STAGE_LABELS: Record<Stage, string> = {
  idle: '',
  uploading: 'Uploading images...',
  processing: 'Processing image (resize/sharpen)...',
  gemini: 'Gemini OCR — analyzing label layout & multilingual text...',
  validating: 'Validating extraction (reliability scoring)...',
  fallback: 'Gemini extraction was insufficient. Running fallback OCR (EasyOCR)...',
  normalizing: 'Normalizing data & merging evidence...',
  rules: 'Running Legal Metrology rule checks (LMPC-001..009)...',
  done: 'Preparing results...',
};

const STAGES_ORDER: Stage[] = ['uploading', 'processing', 'gemini', 'validating', 'normalizing', 'rules', 'done'];

export default function Upload() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [stageIdx, setStageIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const labelOptions = ['Front', 'Back', 'Side', 'Bottom', 'MRP sticker', 'Barcode', 'Close-up', 'Other'];

  function addFiles(newFiles: FileList | File[]) {
    const arr = Array.from(newFiles as FileList);
    const valid = arr.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type));
    if (valid.length !== arr.length) setError('Only JPEG, PNG, WEBP allowed — some files were skipped.');
    else setError(null);
    const combined = [...files, ...valid].slice(0, 8);
    setFiles(combined);
    setPreviews(combined.map(f => URL.createObjectURL(f)));
    setLabels(combined.map((_, i) => labels[i] || labelOptions[Math.min(i, labelOptions.length - 1)]));
    if (combined.length >= 8) setError('Maximum 8 images per scan.');
  }

  function removeAt(idx: number) {
    const nf = files.filter((_, i) => i !== idx);
    const np = previews.filter((_, i) => i !== idx);
    const nl = labels.filter((_, i) => i !== idx);
    setFiles(nf);
    setPreviews(np);
    setLabels(nl);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setStage('uploading');
    setStageIdx(0);

    // Simulate progressive stages (real pipeline does these server-side, but we animate for UX)
    let fallbackTriggered = false;
    const interval = setInterval(() => {
      setStageIdx(prev => {
        const nextIdx = Math.min(prev + 1, STAGES_ORDER.length - 1);
        const nextStage = STAGES_ORDER[nextIdx];
        // Don't auto-advance to fallback unless we know it's needed - keep at validating until response
        if (nextStage === 'fallback' && !fallbackTriggered) return prev;
        setStage(nextStage);
        return nextIdx;
      });
    }, 900);

    try {
      const form = new FormData();
      // Use 'images' for multi, 'image' for single for backward compat - send both conventions
      if (files.length === 1) {
        form.append('image', files[0]);
        form.append('images', files[0]);
      } else {
        files.forEach(f => form.append('images', f));
      }
      // Add labels as metadata header (optional)
      form.append('labels', JSON.stringify(labels));

      setStage('uploading');
      const { data } = await api.post('/scans', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      });

      // Check if fallback was used from response
      if (data.ocr?.fallback_used || data.ocr_engine?.includes('fallback') || data.ocr_engine === 'easyocr') {
        fallbackTriggered = true;
        setStage('fallback');
        await new Promise(r => setTimeout(r, 900));
      }

      clearInterval(interval);
      setStage('done');
      // Navigate using id or scan_id
      const id = data.id || data.scan_id;
      navigate(`/scans/${id}`);
    } catch (err: any) {
      clearInterval(interval);
      const msg = err?.response?.data?.error || err.message || 'Scan failed. Is the OCR service running?';
      // Map Gemini errors to user-friendly per spec
      if (msg.includes('Gemini')) setError(msg);
      else setError(msg);
      setStage('idle');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-5 py-10">
      <h1 className="text-xl font-semibold mb-1">New scan</h1>
      <p className="text-sm text-ink/55 mb-6">
        Upload 1–8 photos of the product package (Front, Back, Side, MRP sticker, Barcode). Gemini will analyze layout & multilingual text; fallback EasyOCR runs automatically if needed. The rule engine produces <span className="font-medium">AI Observations</span> — never a final verdict — for human review.
      </p>

      <form onSubmit={handleSubmit} className="border border-line bg-white rounded-sm p-6">
        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center border-2 border-dashed rounded-sm py-8 cursor-pointer transition-colors ${dragOver ? 'border-brass bg-brass/5' : 'border-line hover:border-brass/60'}`}
        >
          <p className="text-sm font-medium">Drag & drop images here or click to choose</p>
          <p className="text-xs text-ink/45 mt-1">JPEG, PNG or WEBP — up to 8 images, 10MB each</p>
          <p className="text-[11px] text-ink/35 mt-1">{files.length}/8 selected</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={e => e.target.files && addFiles(e.target.files)}
        />

        {/* Previews */}
        {previews.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
            {previews.map((src, idx) => (
              <div key={idx} className="border border-line rounded-sm bg-paper p-2">
                <img src={src} alt={`Preview ${idx}`} className="w-full h-28 object-cover rounded-sm border border-line" />
                <select value={labels[idx] || 'Other'} onChange={e => setLabels(l => { const c = [...l]; c[idx] = e.target.value; return c; })} className="mt-2 w-full text-xs border border-line rounded-sm px-1 py-1 bg-white">
                  {labelOptions.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[11px] text-ink/50 truncate">{files[idx].name}</span>
                  <button type="button" onClick={() => removeAt(idx)} className="text-[11px] text-signal-missing hover:underline">Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <div className="mt-4 text-sm border border-signal-missing/30 bg-signal-missing/10 text-signal-missing px-3 py-2 rounded-sm">{error}</div>}

        {/* Progress stages */}
        {busy && (
          <div className="mt-5 border border-line rounded-sm p-4 bg-paper">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-2 w-2 rounded-full bg-brass animate-pulse" />
              <span className="text-xs font-medium text-ink/70">{STAGE_LABELS[stage] || 'Working...'}</span>
              <span className="ml-auto text-[11px] text-ink/40">{stageIdx + 1}/{STAGES_ORDER.length}</span>
            </div>
            <div className="h-1 bg-line rounded-full overflow-hidden">
              <div className="h-full bg-ink transition-all duration-700" style={{ width: `${((stageIdx + 1) / STAGES_ORDER.length) * 100}%` }} />
            </div>
            <div className="mt-2 flex gap-1 flex-wrap">
              {STAGES_ORDER.map((s, i) => (
                <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded-sm border ${i <= stageIdx ? 'bg-ink text-paper border-ink' : 'text-ink/40 border-line'}`}>{s}</span>
              ))}
            </div>
            <p className="text-[11px] text-ink/45 mt-2">Do not close this page — processing is server-side. Fallback OCR will run automatically if Gemini is insufficient.</p>
          </div>
        )}

        <button
          disabled={files.length === 0 || busy}
          className="mt-6 w-full bg-ink text-paper py-2.5 rounded-sm font-medium hover:bg-slate-950 disabled:opacity-50"
        >
          {busy ? (STAGE_LABELS[stage] || 'Processing...') : `Run compliance scan (${files.length} image${files.length !== 1 ? 's' : ''})`}
        </button>
      </form>

      <div className="mt-4 text-xs text-ink/45">
        <p>Note: Gemini is primary; EasyOCR fallback runs automatically on timeout, low confidence, or insufficient extraction. Rule engine remains deterministic — Gemini only extracts evidence.</p>
      </div>
    </div>
  );
}
