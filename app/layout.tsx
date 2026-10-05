import './globals.css';
import type { Metadata, Viewport } from 'next';
import { QueryProvider } from '@/components/providers/query-provider';
import { ThemeProviderWrapper } from '@/components/providers/theme-provider';

export const metadata: Metadata = {
  title: 'ASTAR TRAVELS — Fleet Intelligence & Operations',
  description:
    'Enterprise fleet management, real-time driver tracking, and financial operations platform.',
  icons: {
    icon: '/icon.svg',
  },
};

/**
 * Declared separately from `metadata` because Next.js 13.2 moved `themeColor`
 * out of the metadata object and into its own `viewport` export. Left inside
 * `metadata` it is ignored and logged as an invalid key at build time.
 *
 * The value is declared for both schemes so the browser chrome matches whichever
 * theme is active. A single hardcoded colour would pin the address bar to the
 * dark canvas even on a light page, which reads as a rendering fault rather than
 * a choice. `media` selects per scheme; browsers that ignore the array fall back
 * to the first entry, which is the dark canvas.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F8FAFC' },
    { media: '(prefers-color-scheme: dark)', color: '#121418' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` is required, and is not papering over a bug.
     * next-themes injects a blocking inline script that sets the theme class on
     * <html> before first paint — that early write is what prevents the flash
     * of the wrong colour scheme. It runs before React hydrates, so the server
     * rendered `class=""` while the client sees `class="dark"`. The attribute
     * legitimately differs; without this React logs a mismatch on every load.
     */
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProviderWrapper>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProviderWrapper>
      </body>
    </html>
  );
}
