import type { Metadata, Viewport } from 'next';
import { Archivo, Bodoni_Moda, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { themeBootScript } from '@/components/ThemeToggle';

// Archivo is loaded as a variable font with its width axis exposed, so large
// figures can be set in the expanded cut (`.wide`) while UI text stays normal.
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

/*
 * The titling face.
 *
 * A Didone, because the genre this product is borrowing authority from is
 * security printing — diplomas, share certificates, banknotes — and that genre
 * is set in Didones. The flat unbracketed serifs and the extreme thick/thin
 * contrast are the engraved-plate look directly, rather than a warm editorial
 * serif standing in for it.
 *
 * It is titling only. Bodoni's hairlines disappear below about 24px, so
 * everything from section headings down is still Archivo.
 */
const bodoni = Bodoni_Moda({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
  display: 'swap',
  /*
   * Next cannot build the metric-matched fallback for this family, so it is
   * built by hand in `globals.css` instead — see the note on
   * `@font-face Bodoni Moda Fallback` there.
   *
   * Next normalises the family name to `bodoniModa` and looks it up in its
   * bundled capsize table; that table's key is `bodoniModa11pt`, so the lookup
   * misses and it logs `Failed to find font override values`. Left alone the
   * consequence is not cosmetic: with `display: swap` and no size-adjusted
   * fallback, the browser paints Times, then reflows when Bodoni arrives — and
   * this face is only ever used on the largest type on the page, which is
   * exactly where that shift is most visible.
   *
   * `adjustFontFallback: false` stops Next attempting a lookup that cannot
   * succeed, and hands the fallback list below to the generated rule.
   */
  adjustFontFallback: false,
  fallback: ['Bodoni Moda Fallback', 'Times New Roman', 'Georgia', 'serif'],
});

export const metadata: Metadata = {
  title: 'Klyro — External Exposure Assessment',
  description:
    'Assess any domain’s external security posture in under 60 seconds using passive reconnaissance. Composite scoring, industry benchmarking, and an executive PDF report.',
  applicationName: 'Klyro',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  // One entry per scheme, so the browser chrome follows the page instead of
  // sitting in the dark ground behind a light document.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0E14' },
    { media: '(prefers-color-scheme: light)', color: '#EEF0F3' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexMono.variable} ${bodoni.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Before first paint — see the note on `themeBootScript`. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
