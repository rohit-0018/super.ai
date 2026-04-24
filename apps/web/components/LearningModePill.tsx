'use client';
import Link from 'next/link';
import { useApi } from '../lib/useApi';
import { Skeleton } from './ui/Skeleton';

interface LearningConfig {
  enabled: boolean;
  autonomyLevel: 'MANUAL' | 'GUIDED' | 'SEMI_AUTO' | 'FULL_AUTO';
}

const LABEL: Record<LearningConfig['autonomyLevel'], string> = {
  MANUAL: 'Manual',
  GUIDED: 'Guided',
  SEMI_AUTO: 'Semi',
  FULL_AUTO: 'Auto',
};

export default function LearningModePill() {
  const { data: lc, loading } = useApi<LearningConfig>('/me/learning-config');
  if (loading || !lc) return <Skeleton w={90} h={24} rounded="md" />;

  const off = !lc.enabled || lc.autonomyLevel === 'MANUAL';
  const color = off ? 'var(--text-3)' : lc.autonomyLevel === 'FULL_AUTO' ? 'var(--warn)' : 'var(--accent)';
  const label = !lc.enabled ? 'Learning: Off' : `Learning: ${LABEL[lc.autonomyLevel]}`;

  return (
    <Link
      href="/settings"
      className="chip hover:border-[color:var(--accent)] transition-colors"
      style={{
        color,
        borderColor: off ? undefined : `color-mix(in srgb, ${color} 40%, var(--border))`,
        gap: 6,
      }}
      title={lc.enabled ? 'Progressive learning is on — manage in Settings' : 'Progressive learning is off — manage in Settings'}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </Link>
  );
}
