import type { Config } from 'tailwindcss';

/**
 * Palette rule: hue is reserved for risk, and for the seal.
 *
 * Every neutral below is a step on one ramp, and the only saturated values in
 * the system are `risk.*` and `seal`. That is what makes a red row read as
 * urgent — almost nothing else on the page is competing for the same
 * attention. The seal is the single exception, and it is rationed to the
 * things that certify rather than warn: the mark, the dial's index, the score
 * ring, and the one button the page exists for.
 *
 * Values live in `globals.css` as raw RGB channels, one set per theme. They
 * are wired up here through `rgb(var(--token) / <alpha-value>)` rather than
 * `var(--token)` directly, because the shorthand form is what keeps Tailwind's
 * opacity modifiers working — `bg-risk-warn/25` and `border-line/40` are used
 * throughout and would silently resolve to nothing otherwise.
 */
const channel = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: channel('--ground'),
        panel: channel('--panel'),
        raised: channel('--raised'),
        line: {
          DEFAULT: channel('--line'),
          strong: channel('--line-strong'),
        },
        tx: {
          DEFAULT: channel('--tx'),
          2: channel('--tx-2'),
          3: channel('--tx-3'),
        },
        seal: {
          DEFAULT: channel('--seal'),
          ink: channel('--seal-ink'),
          on: channel('--on-seal'),
          dim: channel('--seal-dim'),
        },
        risk: {
          good: channel('--risk-good'),
          warn: channel('--risk-warn'),
          bad: channel('--risk-bad'),
          high: channel('--risk-high'),
          low: channel('--risk-low'),
          info: channel('--risk-info'),
        },
      },
      fontFamily: {
        // Archivo, kept. Its width axis is exposed, and `.num` / `.wide` /
        // `.narrow` set `font-stretch` against it — a face without that axis
        // would flatten every large figure on the site without erroring.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        display: ['var(--font-display)', 'ui-serif', 'Georgia', 'serif'],
      },
      borderRadius: {
        DEFAULT: '4px',
        panel: '6px',
      },
      boxShadow: {
        panel: '0 1px 0 0 rgb(var(--tx) / 0.025) inset',
        lift: '0 24px 60px -32px rgb(var(--ground) / 0.9), 0 1px 0 0 rgb(var(--tx) / 0.03) inset',
        seal: '0 0 0 1px rgb(var(--seal) / 0.35), 0 18px 44px -28px rgb(var(--seal) / 0.55)',
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
