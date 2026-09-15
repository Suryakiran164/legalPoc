import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Scan } from '../api/client';

export default function ScanHistory() {
  const [scans, setScans] = useState<Scan[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { search(); }, []);

  async function search(query?: string) {
    setLoading(true);
    try {
      const { data } = await api.get('/scans', { params: query ? { q: query } : {} });
      setScans(data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-5 py-8">
      <h1 className="text-xl font-semibold mb-4">Scan history</h1>

      <form onSubmit={(e) => { e.preventDefault(); search(q); }} className="flex gap-2 mb-6">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by commodity name, manufacturer, or filename…"
          className="flex-1 px-3 py-2 text-sm border border-line rounded-sm bg-white focus:outline-none focus:ring-2 focus:ring-brass/40"
        />
        <button className="px-4 py-2 border border-line rounded-sm text-sm font-medium hover:bg-ink hover:text-paper">Search</button>
      </form>

      <div className="border border-line rounded-sm bg-white overflow-hidden">
        <div className="grid grid-cols-12 px-4 py-2 text-[11px] uppercase tracking-wide text-ink/45 border-b border-line">
          <div className="col-span-4">Commodity / File</div>
          <div className="col-span-3">Manufacturer</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-3">Date</div>
        </div>
        {loading && <p className="p-6 text-sm text-ink/50">Loading…</p>}
        {!loading && scans.length === 0 && <p className="p-6 text-sm text-ink/50">No scans found.</p>}
        {scans.map((s) => {
          const f = s.corrected_fields || s.extracted_fields;
          return (
            <Link key={s.id} to={`/scans/${s.id}`} className="grid grid-cols-12 px-4 py-3 text-sm border-b border-line last:border-0 hover:bg-paper items-center">
              <div className="col-span-4 font-medium">{f.commodity_name || s.original_filename}</div>
              <div className="col-span-3 text-ink/60 truncate">{f.manufacturer_name || '—'}</div>
              <div className="col-span-2 text-xs font-mono uppercase text-ink/50">{s.status}</div>
              <div className="col-span-3 text-xs text-ink/50 font-mono">{new Date(s.created_at).toLocaleString('en-IN')}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
