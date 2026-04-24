import Link from 'next/link';
import type { ReactNode } from 'react';

export type ShortcutTileProps = {
  href: string;
  label: string;
  hint?: string;
  badge?: { text: string; tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'accent-2' };
  icon: ReactNode;
  tone?: 'accent' | 'accent-2';
};

export function ShortcutTile({ href, label, hint, badge, icon, tone = 'accent' }: ShortcutTileProps) {
  const col = tone === 'accent' ? 'var(--accent)' : 'var(--accent-2)';
  const badgeCls =
    badge?.tone === 'ok' ? 'chip chip-ok' :
    badge?.tone === 'warn' ? 'chip chip-warn' :
    badge?.tone === 'bad' ? 'chip chip-bad' :
    badge?.tone === 'accent-2' ? 'chip chip-accent-2' :
    badge?.tone === 'accent' ? 'chip chip-accent' :
    'chip';

  return (
    <Link
      href={href}
      className="group"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-card)',
        color: 'var(--text)',
        transition: 'border-color 140ms ease, background 140ms ease, transform 140ms ease',
        minHeight: 92,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div className="flex items-start justify-between">
        <span
          aria-hidden
          className="inline-flex items-center justify-center"
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: `color-mix(in srgb, ${col} 14%, var(--surface-2))`,
            color: col,
            border: `1px solid color-mix(in srgb, ${col} 28%, var(--border))`,
          }}
        >
          {icon}
        </span>
        {badge && <span className={badgeCls}>{badge.text}</span>}
      </div>
      <div>
        <div className="text-[13px] font-semibold tracking-tight">{label}</div>
        {hint && (
          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--text-3)' }}>
            {hint}
          </div>
        )}
      </div>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          right: 12, bottom: 10,
          color: 'var(--text-3)',
          fontSize: 12,
          opacity: 0.6,
          transition: 'transform 140ms ease, color 140ms ease, opacity 140ms ease',
        }}
        className="group-hover:[transform:translateX(2px)] group-hover:[color:var(--text-2)] group-hover:[opacity:1]"
      >
        →
      </span>
    </Link>
  );
}
