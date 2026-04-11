import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-solid': 'var(--surface-solid)',
        'surface-hover': 'var(--surface-hover)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        text: 'var(--text)',
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
      },
      boxShadow: {
        lg: 'var(--shadow-lg)',
        glow: 'var(--shadow-glow)',
      },
      borderRadius: {
        xl: '14px',
        '2xl': '20px',
      },
    },
  },
  plugins: [],
};
export default config;
