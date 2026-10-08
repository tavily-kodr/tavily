import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tavily Search Engine - AI Web Intelligence',
  description: 'Production-grade AI Search Engine with multi-factor ranking, deduplication, and grounded synthesis.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
