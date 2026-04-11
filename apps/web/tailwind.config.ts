import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0e1a',
        panel: '#0f1525',
        accent: '#00d4ff',
        ok: '#00ff9f',
        warn: '#ffb84d',
        bad: '#ff5577',
      },
    },
  },
  plugins: [],
};
export default config;
