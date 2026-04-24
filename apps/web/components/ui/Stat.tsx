import type { ReactNode } from 'react';

type Size = 'sm' | 'md' | 'hero';

export function Stat({
  label,
  value,
  delta,
  deltaTone,
  size = 'md',
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: 'up' | 'down' | 'flat';
  size?: Size;
  hint?: ReactNode;
}) {
  const valueClass =
    size === 'hero' ? 'stat-value-hero' : size === 'sm' ? 'stat-value-sm' : 'stat-value';
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={valueClass}>{value}</span>
        {delta != null && <DeltaPill tone={deltaTone}>{delta}</DeltaPill>}
      </div>
      {hint && (
        <span className="text-[11.5px] mt-0.5" style={{ color: 'var(--text-3)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function DeltaPill({
  tone = 'flat',
  children,
}: {
  tone?: 'up' | 'down' | 'flat';
  children: ReactNode;
}) {
  const cls =
    tone === 'up' ? 'stat-delta up' : tone === 'down' ? 'stat-delta down' : 'stat-delta';
  const arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '·';
  return (
    <span className={cls}>
      <span style={{ fontSize: 9, lineHeight: 1 }}>{arrow}</span>
      {children}
    </span>
  );
}
