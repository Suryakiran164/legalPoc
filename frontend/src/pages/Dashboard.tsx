import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DashboardSummary } from '../api/client';

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get('/dashboard/summary')
      .then((res) => setSummary(res.data))
      .catch(() => setError('Could not load dashboard summary.'));
  }, []);

  if (error) return <div className="max-w-6xl mx-auto px-5 py-8 text-signal-missing text-sm">{error}</div>;
  if (!summary) return <div className="max-w-6xl mx-auto px-5 py-8 text-sm text-ink/55">Loading dashboard…</div>;

  const cards = [
    { label: 'Total scans', value: summary.total_scans },
    { label: 'Reviewed by inspector', value: summary.scans_reviewed },
    { label: 'Pending review', value: summary.scans_pending_review },
    { label: 'Possible issues flagged', value: summary.total_possible_issues },
    { label: 'Requires verification', value: summary.total_requires_verification },
  ];

  return (
    <div className="max-w-6xl mx-auto px-5 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Link to="/upload" className="bg-ink text-paper px-4 py-2 rounded-sm text-sm font-medium hover:bg-slate-950">
          + New Scan
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-10">
        {cards.map((c) => (
          <div key={c.label} className="border border-line bg-white rounded-sm p-4">
            <p className="text-2xl font-semibold font-mono">{c.value}</p>
            <p className="text-xs text-ink/55 mt-1">{c.label}</p>
          </div>
        ))}
      </div>

      <h2 className="text-sm font-semibold text-ink/70 mb-3">Recent activity</h2>
      <div className="border border-line rounded-sm bg-white overflow-hidden">
        {summary.recent_activity.length === 0 && (
          <p className="p-6 text-sm text-ink/50">No scans yet. Upload a package label to get started.</p>
        )}
        {summary.recent_activity.map((item) => (
          <Link
            key={item.id}
            to={`/scans/${item.id}`}
            className="flex items-center justify-between px-4 py-3 border-b border-line last:border-0 hover:bg-paper text-sm"
          >
            <div>
              <p className="font-medium">{item.commodity_name || item.original_filename}</p>
              <p className="text-xs text-ink/50 font-mono">{new Date(item.created_at).toLocaleString('en-IN')}</p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              {item.possible_issues > 0 && <span className="text-signal-issue">{item.possible_issues} possible issue(s)</span>}
              {item.requires_verification > 0 && <span className="text-signal-verify">{item.requires_verification} to verify</span>}
              <span className="uppercase tracking-wide text-ink/40 font-mono">{item.status}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
