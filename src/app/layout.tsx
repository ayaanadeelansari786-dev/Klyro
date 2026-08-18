import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

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

export const metadata: Metadata = {
  title: 'Klyro — External Exposure Assessment',
  description:
    'Assess any domain’s external security posture in under 60 seconds using passive reconnaissance. Composite scoring, industry benchmarking, and an executive PDF report.',
  applicationName: 'Klyro',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#08090B',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
