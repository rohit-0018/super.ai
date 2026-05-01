export default function IntelLoading() {
  return (
    <div style={{ padding: '18px 20px 32px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* indeterminate bar */}
      <div style={{ position: 'relative', height: 2, borderRadius: 2, overflow: 'hidden', background: 'rgba(255,255,255,0.05)', marginBottom: 14 }}>
        <div style={{ position: 'absolute', top: 0, height: '100%', borderRadius: 2, background: 'var(--accent)', animation: 'load-bar 1.6s ease-in-out infinite' }} />
      </div>

      {/* header skeleton */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ height: 11, width: 120, borderRadius: 4, background: 'var(--surface-2)', marginBottom: 8 }} />
        <div style={{ height: 22, width: 220, borderRadius: 4, background: 'var(--surface-2)' }} />
      </div>

      {/* token header card */}
      <div className="section" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          {[120, 60, 80].map((w, i) => (
            <div key={i} style={{ height: i === 0 ? 26 : 20, width: w, borderRadius: 4, background: 'linear-gradient(90deg, var(--surface-2) 0%, rgba(255,255,255,0.09) 50%, var(--surface-2) 100%)', backgroundSize: '200% 100%', animation: 'shimmer-bg 1.4s linear infinite' }} />
          ))}
        </div>
        <div style={{ height: 36, width: 180, borderRadius: 4, marginBottom: 10, background: 'linear-gradient(90deg, var(--surface-2) 0%, rgba(255,255,255,0.09) 50%, var(--surface-2) 100%)', backgroundSize: '200% 100%', animation: 'shimmer-bg 1.4s linear infinite' }} />
        <div style={{ display: 'flex', gap: 20 }}>
          {[80, 80, 80, 80].map((w, i) => (
            <div key={i} style={{ height: 14, width: w, borderRadius: 4, background: 'linear-gradient(90deg, var(--surface-2) 0%, rgba(255,255,255,0.09) 50%, var(--surface-2) 100%)', backgroundSize: '200% 100%', animation: 'shimmer-bg 1.4s linear infinite' }} />
          ))}
        </div>
      </div>

      {/* verdict skeleton */}
      <div className="section" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <div style={{ width: 108, height: 108, borderRadius: '50%', background: 'var(--surface-2)', flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['40%', '60%', '30%'].map((w, i) => (
              <div key={i} style={{ height: i === 1 ? 34 : 14, width: w, borderRadius: 4, background: 'linear-gradient(90deg, var(--surface-2) 0%, rgba(255,255,255,0.09) 50%, var(--surface-2) 100%)', backgroundSize: '200% 100%', animation: 'shimmer-bg 1.4s linear infinite' }} />
            ))}
          </div>
        </div>
      </div>

      {/* 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[0, 1].map(i => (
          <div key={i} className="section">
            <div style={{ padding: '0 14px', height: 44, display: 'flex', alignItems: 'center' }}>
              <div style={{ height: 14, width: '50%', borderRadius: 4, background: 'var(--surface-2)' }} />
            </div>
            <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...Array(4)].map((_, j) => (
                <div key={j} style={{ height: 12, borderRadius: 4, background: 'linear-gradient(90deg, var(--surface-2) 0%, rgba(255,255,255,0.09) 50%, var(--surface-2) 100%)', backgroundSize: '200% 100%', animation: 'shimmer-bg 1.4s linear infinite' }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
