'use client';
import { useState } from 'react';

export type RejectCategory = 'TOO_RISKY' | 'WRONG_TOKEN' | 'BAD_TIMING' | 'WRONG_SIZE' | 'OTHER';

const PRESETS: { key: RejectCategory; label: string }[] = [
  { key: 'TOO_RISKY', label: 'Too risky' },
  { key: 'WRONG_TOKEN', label: 'Wrong token' },
  { key: 'BAD_TIMING', label: 'Bad timing' },
  { key: 'WRONG_SIZE', label: 'Wrong size' },
  { key: 'OTHER', label: 'Other' },
];

interface Props {
  onCancel: () => void;
  onConfirm: (payload: { rejectCategory: RejectCategory; rejectReason?: string }) => void;
  busy?: boolean;
}

export default function RejectReasonPicker({ onCancel, onConfirm, busy }: Props) {
  const [category, setCategory] = useState<RejectCategory>('TOO_RISKY');
  const [reason, setReason] = useState('');

  return (
    <div className="panel" style={{ padding: 12, marginTop: 8 }}>
      <div className="text-[12px] font-medium mb-2">Why reject?</div>
      <div className="flex flex-wrap gap-1 mb-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setCategory(p.key)}
            className="chip"
            style={{
              fontSize: 11,
              padding: '4px 10px',
              cursor: 'pointer',
              borderColor: category === p.key ? 'var(--accent)' : undefined,
              color: category === p.key ? 'var(--accent)' : undefined,
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 500))}
        placeholder="Optional note (500 chars)"
        className="input"
        rows={2}
        style={{ fontSize: 12, resize: 'vertical', width: '100%' }}
      />
      <div className="flex justify-end gap-1 mt-2">
        <button onClick={onCancel} disabled={busy} className="btn" style={{ padding: '4px 10px', fontSize: 12 }}>
          Cancel
        </button>
        <button
          onClick={() => onConfirm({ rejectCategory: category, rejectReason: reason.trim() || undefined })}
          disabled={busy}
          className="btn"
          style={{ padding: '4px 10px', fontSize: 12, color: 'var(--bad)', borderColor: 'var(--bad)' }}
        >
          Confirm reject
        </button>
      </div>
    </div>
  );
}
