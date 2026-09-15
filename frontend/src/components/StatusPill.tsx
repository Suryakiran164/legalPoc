import React from 'react';
import type { ObservationStatus } from '../api/client';

const CONFIG: Record<ObservationStatus, { label: string; className: string }> = {
  ok: { label: 'No Issue Observed', className: 'border-signal-ok/30 text-signal-ok bg-signal-ok/10' },
  possible_issue: { label: 'Possible Issue', className: 'border-signal-issue/30 text-signal-issue bg-signal-issue/10' },
  missing_mandatory_declaration: { label: 'Missing Mandatory Declaration', className: 'border-signal-missing/30 text-signal-missing bg-signal-missing/10' },
  requires_human_verification: { label: 'Requires Human Verification', className: 'border-signal-verify/30 text-signal-verify bg-signal-verify/10' },
  not_found: { label: 'Not Found', className: 'border-signal-missing/30 text-signal-missing bg-signal-missing/10' },
  unreadable: { label: 'Unreadable', className: 'border-signal-verify/30 text-signal-verify bg-signal-verify/10' },
  not_applicable: { label: 'Not Applicable', className: 'border-line text-ink/40 bg-paper' },
  conflicting: { label: 'Conflicting', className: 'border-signal-issue/30 text-signal-issue bg-signal-issue/10' },
  verified: { label: 'Verified', className: 'border-signal-ok/30 text-signal-ok bg-signal-ok/10' },
};

export default function StatusPill({ status }: { status: ObservationStatus }) {
  const cfg = CONFIG[status] || { label: status, className: 'border-line text-ink/60' };
  return <span className={`status-pill ${cfg.className}`}>{cfg.label}</span>;
}
