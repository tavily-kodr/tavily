import { ScraperService } from '../services/scraper.service';
import { ExtractionService } from '../services/extraction.service';

export async function testScraperService() {
  console.log('--- Testing ScraperService & ExtractionService ---');

  const extractionService = new ExtractionService();
  const scraperService = new ScraperService(extractionService);

  // 1. Content Extraction from synthetic HTML with noise
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Quantum Computing Breakthrough</title>
        <meta name="description" content="Overview of recent quantum supremacy experiments." />
        <meta name="author" content="Dr. Jane Doe" />
        <meta property="article:published_time" content="2026-09-15T12:00:00Z" />
        <link rel="canonical" href="https://research.org/quantum-breakthrough" />
      </head>
      <body>
        <header><nav><a href="/">Home</a><a href="/login">Login</a></nav></header>
        <div class="cookie-banner">Please accept cookies to proceed.</div>
        <article>
          <h1>Quantum Computing Breakthrough</h1>
          <p>Researchers have demonstrated coherent qubits operating at room temperature with high fidelity.</p>
          <h2>Key Advantages</h2>
          <ul>
            <li>No cryogenic cooling required</li>
            <li>Reduced error propagation</li>
          </ul>
        </article>
        <aside class="sidebar">Related news and ads here</aside>
        <footer>Copyright 2026 Research Org</footer>
      </body>
    </html>
  `;

  const extracted = extractionService.extract(sampleHtml, 'https://research.org/quantum-breakthrough');

  if (extracted.title !== 'Quantum Computing Breakthrough') {
    throw new Error(`Expected title 'Quantum Computing Breakthrough', got '${extracted.title}'`);
  }
  if (!extracted.content.includes('Researchers have demonstrated coherent qubits')) {
    throw new Error('Main content was not extracted properly');
  }
  if (extracted.content.includes('Please accept cookies') || extracted.content.includes('Login')) {
    throw new Error('Boilerplate noise (cookie banner or nav) was not filtered out');
  }
  if (extracted.author !== 'Dr. Jane Doe') {
    throw new Error(`Expected author 'Dr. Jane Doe', got '${extracted.author}'`);
  }
  if (!extracted.publishedDate) {
    throw new Error('Published date was not extracted');
  }
  console.log('✓ HTML content extraction stripped noise and extracted structured headings and metadata');

  // 2. SSRF Protection: blocked private/internal URLs
  const privateUrlResult = await scraperService.scrape('http://127.0.0.1:8080/admin');
  if (privateUrlResult.status !== 'blocked') {
    throw new Error(`Expected SSRF private address to be blocked, got ${privateUrlResult.status}`);
  }
  console.log('✓ SSRF Protection blocked private IP address (127.0.0.1)');

  // 3. Invalid URL handling
  const invalidUrlResult = await scraperService.scrape('not-a-valid-url');
  if (invalidUrlResult.status !== 'failed') {
    throw new Error(`Expected invalid URL to fail, got ${invalidUrlResult.status}`);
  }
  console.log('✓ Invalid URL handled safely without crash');
}
