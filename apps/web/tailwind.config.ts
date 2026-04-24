import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-2': 'var(--bg-2)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-solid': 'var(--surface-solid)',
        'surface-hover': 'var(--surface-hover)',
        border: 'var(--border)',
        'border-2': 'var(--border-2)',
        'border-strong': 'var(--border-strong)',
        text: 'var(--text)',
        'text-2': 'var(--text-2)',
        'text-3': 'var(--text-3)',
        muted: 'var(--text-muted)',
        dim: 'var(--text-dim)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        ok: 'var(--ok)',
        good: 'var(--ok)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
        panel: 'var(--surface-solid)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'system-ui'],
      },
      boxShadow: {
        lg: 'var(--shadow-lg)',
        glow: 'var(--shadow-glow)',
        'glow-cyan': '0 0 32px -6px var(--glow-cyan)',
        'glow-magenta': '0 0 32px -6px var(--glow-magenta)',
      },
      borderRadius: {
        xl: '14px',
        '2xl': '20px',
      },
      backgroundImage: {
        'cyber-gradient': 'linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%)',
      },
    },
  },
  plugins: [],
};
export default config;
