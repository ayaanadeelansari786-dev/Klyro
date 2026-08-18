import type { Config } from 'tailwindcss';

/**
 * Palette rule: hue is reserved for risk.
 *
 * Every neutral below is a step on one graphite ramp, and the only saturated
 * values in the system are `risk.*`. That is what makes a red row read as
 * urgent — nothing else on the page is competing for the same attention.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: '#08090B',
        panel: '#0E1013',
        raised: '#14171C',
        line: {
          DEFAULT: '#1C2027',
          strong: '#272C35',
        },
        tx: {
          DEFAULT: '#ECEEF2',
          2: '#9AA1AD',
          3: '#656C78',
        },
        risk: {
          good: '#00E676',
          warn: '#FFB300',
          bad: '#FF3D3D',
          high: '#FF7043',
          low: '#4FC3F7',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '4px',
        panel: '6px',
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.025) inset',
        lift: '0 24px 60px -32px rgba(0,0,0,0.9), 0 1px 0 0 rgba(255,255,255,0.03) inset',
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        sweep: {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
      },
      animation: {
        rise: 'rise 0.42s cubic-bezier(0.16, 1, 0.3, 1) both',
        sweep: 'sweep 0.9s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
