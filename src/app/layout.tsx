import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tavily Search Engine - AI Web Intelligence',
  description: 'Production-grade AI Search Engine with web scraping, multi-factor ranking, and real-time triggers.',
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
