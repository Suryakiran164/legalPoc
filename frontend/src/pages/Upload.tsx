import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export default function Upload() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFile(f: File | null) {
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('image', file);
      const { data } = await api.post('/scans', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      navigate(`/scans/${data.id}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Scan failed. Is the OCR service running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-5 py-10">
      <h1 className="text-xl font-semibold mb-1">New scan</h1>
      <p className="text-sm text-ink/55 mb-6">
        Upload a photo of the product package or label. OCR will extract the declarations, and the rule engine
        will produce AI Observations against the Legal Metrology (Packaged Commodities) Rules, 2011 checklist — never a final verdict.
      </p>

      <form onSubmit={handleSubmit} className="border border-line bg-white rounded-sm p-6">
        <label
          htmlFor="file-input"
          className="flex flex-col items-center justify-center border-2 border-dashed border-line rounded-sm py-10 cursor-pointer hover:border-brass/60 transition-colors"
        >
          {preview ? (
            <img src={preview} alt="Preview" className="max-h-64 rounded-sm" />
          ) : (
            <>
              <p className="text-sm font-medium">Click to choose an image</p>
              <p className="text-xs text-ink/45 mt-1">JPEG, PNG or WEBP, up to 10MB</p>
            </>
          )}
        </label>
        <input
          id="file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] || null)}
        />

        {error && <div className="mt-4 text-sm border border-signal-missing/30 bg-signal-missing/10 text-signal-missing px-3 py-2 rounded-sm">{error}</div>}

        <button
          disabled={!file || busy}
          className="mt-6 w-full bg-ink text-paper py-2.5 rounded-sm font-medium hover:bg-slate-950 disabled:opacity-50"
        >
          {busy ? 'Running OCR + rule checks…' : 'Run compliance scan'}
        </button>
      </form>
    </div>
  );
}
