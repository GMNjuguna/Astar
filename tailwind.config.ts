import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /*
         * Semantic theme tokens. Each expands to `rgb(var(--x) / <alpha-value>)`
         * so the opacity modifier keeps working (`bg-canvas/75`, `border-line/40`).
         * The variables are declared per theme in app/globals.css and flip when
         * next-themes sets `class="dark"` on <html>.
         *
         * Components use these instead of literal hex values. That is the only
         * reason a theme switch is a one-line change rather than an audit of
         * every call site — see the token comments in globals.css for the
         * contrast measurements behind each value.
         */
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        'line-strong': 'rgb(var(--line-strong) / <alpha-value>)',
        content: 'rgb(var(--content) / <alpha-value>)',
        'content-muted': 'rgb(var(--content-muted) / <alpha-value>)',
        'content-subtle': 'rgb(var(--content-subtle) / <alpha-value>)',

        /*
         * Brand accent, legible as text in both themes. Light resolves to
         * brand-700 (#C23027, 5.61:1 on white); dark resolves to #FF8F3D
         * (7.4:1 on #121418). The raw #FF4E42 fails AA as text on white at
         * 3.3:1 and so is not what this token resolves to.
         */
        accent: 'rgb(var(--accent) / <alpha-value>)',
        /** Filled button surface. Always carries white text (5.61:1). */
        'brand-solid': 'rgb(var(--brand-solid) / <alpha-value>)',
        'brand-solid-strong': 'rgb(var(--brand-solid-strong) / <alpha-value>)',

        /*
         * The literal brand ramp, kept for decorative use only — gradients,
         * glows and dot accents where the value is never read as text. The tints
         * are unchanged from the original scale; 500/600/700 are still available
         * because `bg-brand-700` with white text passes AA at 5.61:1.
         */
        brand: {
          50: '#FFF5F4',
          100: '#FFEBE9',
          200: '#FFD1CD',
          500: '#FF4E42',
          600: '#E03E33',
          700: '#C23027',
          DEFAULT: '#FF4E42',
        },
        primary: {
          start: '#FF4E42',
          end: '#FF8F3D',
        },

        /* Chart palette. Flips per theme; consumed by components/analytics/charts.tsx. */
        'chart-grid': 'rgb(var(--chart-grid) / <alpha-value>)',
        'chart-track': 'rgb(var(--chart-track) / <alpha-value>)',
        'chart-collected': 'rgb(var(--chart-collected) / <alpha-value>)',
        'chart-billed': 'rgb(var(--chart-billed) / <alpha-value>)',
        'chart-servicing': 'rgb(var(--chart-servicing) / <alpha-value>)',
        'chart-inactive': 'rgb(var(--chart-inactive) / <alpha-value>)',
        /**
         * Error / rejection text and marks. Light resolves to red-700 (#B91C1C,
         * 6.47:1 on white) and dark to red-300 (#FCA5A5, 8.30:1 on #1E232D),
         * because the Tailwind red-300 that reads well on a dark card is only
         * 1.90:1 on a white one.
         */
        'chart-danger': 'rgb(var(--chart-danger) / <alpha-value>)',
        /**
         * Role identity, separate from the status ramp above. The user
         * management table gives ceo / developer / manager / driver four
         * distinct hues, so these two exist to keep that encoding without
         * borrowing a status colour. Light resolves to blue-700 / violet-700 and
         * dark to blue-300 / violet-300, because the 300 shades that read on a
         * dark card are only ~2:1 on white.
         */
        'chart-blue': 'rgb(var(--chart-blue) / <alpha-value>)',
        'chart-violet': 'rgb(var(--chart-violet) / <alpha-value>)',

        charcoal: '#121418',
        darkSlate: '#1E2229',
        white: '#FFFFFF',
        softGray: '#F7F9FC',
        muted: '#6C757D',
      },
      boxShadow: {
        glow: '0 0 12px rgba(255, 78, 66, 0.35)',
      },
    },
  },
  plugins: [],
};

export default config;