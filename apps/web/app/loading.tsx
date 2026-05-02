/**
 * Root-level loading.tsx — instantly shown by Next.js when navigating to any
 * route that doesn't have its own loading.tsx. Renders a slim top-progress bar
 * + page-shape skeleton so route transitions feel sub-100ms even when the data
 * fetch hasn't started yet.
 */
export default function RootLoading() {
  return (
    <div style={{ padding: '14px 20px 32px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        aria-label="Loading"
        style={{
          position: 'relative',
          height: 2,
          borderRadius: 2,
          overflow: 'hidden',
          background: 'rgba(255,255,255,0.05)',
          marginBottom: 12,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            height: '100%',
            borderRadius: 2,
            background: 'var(--accent)',
            animation: 'load-bar 1.4s ease-in-out infinite',
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <Bar w={120} h={11} />
        <Bar w={210} h={22} />
      </div>

      {/* Stat strip — 5 placeholders matching .grid-stats */}
      <div className="grid-stats">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="section" style={{ padding: 14 }}>
            <Bar w="60%" h={10} />
            <div style={{ height: 8 }} />
            <Bar w="40%" h={20} />
          </div>
        ))}
      </div>

      {/* Card grid — 4 placeholders */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="section" style={{ padding: 14 }}>
            <Bar w="80%" h={14} />
            <div style={{ height: 8 }} />
            <Bar w="50%" h={11} />
            <div style={{ height: 12 }} />
            <Bar w="100%" h={36} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ w, h }: { w: number | string; h: number }) {
  return (
    <div
      style={{
        height: h,
        width: typeof w === 'number' ? `${w}px` : w,
        borderRadius: 4,
        background:
          'linear-gradient(90deg, var(--surface-2) 0%, rgba(255,255,255,0.09) 50%, var(--surface-2) 100%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer-bg 1.4s linear infinite',
      }}
    />
  );
}
