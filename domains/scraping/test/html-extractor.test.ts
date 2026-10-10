import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractHtml, decodeHtmlEntities } from "../src/utils/html-extractor.js";

describe("HTML Extractor - Entity Decoding", () => {
  it("decodes named HTML entities", () => {
    assert.equal(
      decodeHtmlEntities(
        "&amp; &lt; &gt; &quot; &apos; &nbsp; &copy; &trade; &mdash; &ndash; &hellip; &euro;",
      ),
      "& < > \" '   © ™ — – … €",
    );
  });

  it("decodes decimal numeric entities", () => {
    assert.equal(decodeHtmlEntities("&#65; &#66; &#67; &#8212;"), "A B C —");
  });

  it("decodes hexadecimal numeric entities", () => {
    assert.equal(decodeHtmlEntities("&#x41; &#x42; &#x43; &#X2014;"), "A B C —");
  });

  it("preserves non-entity ampersands and unknown entities intact", () => {
    assert.equal(decodeHtmlEntities("Tom & Jerry"), "Tom & Jerry");
    assert.equal(decodeHtmlEntities("&unknownEntity;"), "&unknownEntity;");
  });
});

describe("HTML Extractor - Metadata Extraction", () => {
  const baseUrl = "https://example.com/docs/";

  it("extracts document title, description, language, and canonical URL", () => {
    const html = `
      <!DOCTYPE html>
      <html lang="en-US">
        <head>
          <title>Tavily Documentation &amp; Guides</title>
          <meta name="description" content="Comprehensive guides and API references for Tavily.">
          <link rel="canonical" href="https://example.com/docs">
        </head>
        <body>
          <p>Content</p>
        </body>
      </html>
    `;

    const result = extractHtml(html, baseUrl);
    assert.equal(result.title, "Tavily Documentation & Guides");
    assert.equal(result.description, "Comprehensive guides and API references for Tavily.");
    assert.equal(result.language, "en-US");
    assert.equal(result.canonicalUrl, "https://example.com/docs");
  });

  it("extracts metadata when attributes are ordered differently or use single quotes", () => {
    const html = `
      <html LANG='fr'>
        <head>
          <meta content='Single quote description' name='description'>
          <link href='/canonical-relative' rel='canonical'>
          <title>   Padded Title   </title>
        </head>
      </html>
    `;

    const result = extractHtml(html, baseUrl);
    assert.equal(result.title, "Padded Title");
    assert.equal(result.description, "Single quote description");
    assert.equal(result.language, "fr");
    assert.equal(result.canonicalUrl, "https://example.com/canonical-relative");
  });

  it("falls back to OpenGraph metadata when standard title and description are absent", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="OpenGraph Title">
          <meta property="og:description" content="OpenGraph Description">
        </head>
        <body><p>Hello</p></body>
      </html>
    `;

    const result = extractHtml(html, baseUrl);
    assert.equal(result.title, "OpenGraph Title");
    assert.equal(result.description, "OpenGraph Description");
  });

  it("gracefully handles missing title, description, language, and canonical link", () => {
    const html = `<div><p>Simple snippet with no metadata</p></div>`;
    const result = extractHtml(html, baseUrl);

    assert.equal(result.title, "");
    assert.equal(result.description, undefined);
    assert.equal(result.canonicalUrl, undefined);
    assert.equal(result.language, undefined);
  });
});

describe("HTML Extractor - Content Cleaning & Structure", () => {
  const baseUrl = "https://example.com/";

  it("preserves paragraphs, headings, lists, and line break boundaries", () => {
    const html = `
      <h1>Main Headline</h1>
      <p>This is the first paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
      <h2>Secondary Section</h2>
      <p>Second paragraph line 1.<br>Second paragraph line 2.</p>
      <ul>
        <li>First bullet point</li>
        <li>Second bullet point</li>
      </ul>
    `;

    const result = extractHtml(html, baseUrl);

    assert.match(result.text, /^Main Headline/);
    assert(result.text.includes("This is the first paragraph with bold and italic text."));
    assert(result.text.includes("Secondary Section"));
    assert(result.text.includes("Second paragraph line 1.\nSecond paragraph line 2."));
    assert(result.text.includes("First bullet point\nSecond bullet point"));
  });

  it("completely strips non-content elements: scripts, styles, noscript, svg, comments", () => {
    const html = `
      <p>Visible intro</p>
      <script>
        const secret = "hidden script logic";
        console.log("<script>nested fake</script>");
      </script>
      <style>
        body { color: red; font-size: 14px; }
      </style>
      <noscript>
        <p>Please enable JavaScript to view this site.</p>
      </noscript>
      <svg width="100" height="100">
        <text>Vector Graphic Text</text>
      </svg>
      <!-- Hidden comment here -->
      <p>Visible conclusion</p>
    `;

    const result = extractHtml(html, baseUrl);

    assert(result.text.includes("Visible intro"));
    assert(result.text.includes("Visible conclusion"));
    assert.equal(result.text.includes("secret"), false);
    assert.equal(result.text.includes("hidden script logic"), false);
    assert.equal(result.text.includes("body { color: red"), false);
    assert.equal(result.text.includes("Please enable JavaScript"), false);
    assert.equal(result.text.includes("Vector Graphic Text"), false);
    assert.equal(result.text.includes("Hidden comment here"), false);
  });

  it("excludes navigation, header, footer, and aside elements from readable text", () => {
    const html = `
      <header>
        <h1>Company Logo Header</h1>
      </header>
      <nav>
        <a href="/home">Home</a>
        <a href="/about">About</a>
      </nav>
      <main>
        <article>
          <h1>Actual Article Title</h1>
          <p>Main content paragraph.</p>
        </article>
      </main>
      <aside>
        <p>Sidebar sponsored ads</p>
      </aside>
      <footer>
        <p>© 2026 Company Inc. All rights reserved.</p>
      </footer>
    `;

    const result = extractHtml(html, baseUrl);

    assert(result.text.includes("Actual Article Title"));
    assert(result.text.includes("Main content paragraph."));
    assert.equal(result.text.includes("Company Logo Header"), false);
    assert.equal(result.text.includes("Sidebar sponsored ads"), false);
    assert.equal(result.text.includes("All rights reserved"), false);

    // Navigation links are still discovered for web crawling
    assert(result.links.includes("https://example.com/home"));
    assert(result.links.includes("https://example.com/about"));
  });

  it("optionally includes boilerplate when includeBoilerplate option is true", () => {
    const html = `
      <header><p>Header Content</p></header>
      <main><p>Body Content</p></main>
      <footer><p>Footer Content</p></footer>
    `;

    const result = extractHtml(html, baseUrl, { includeBoilerplate: true });

    assert(result.text.includes("Header Content"));
    assert(result.text.includes("Body Content"));
    assert(result.text.includes("Footer Content"));
  });
});

describe("HTML Extractor - Link Discovery & Normalization", () => {
  const baseUrl = "https://example.com/docs/intro/";

  it("resolves relative and absolute links against pageUrl and canonicalizes them", () => {
    const html = `
      <a href="/about">About Root</a>
      <a href="../getting-started">Parent Relative</a>
      <a href="deep/page">Child Relative</a>
      <a href="https://external.org/resource/">External</a>
      <a href="https://example.com:443/docs/intro/test#section">Default Port & Fragment</a>
    `;

    const result = extractHtml(html, baseUrl);

    assert(result.links.includes("https://example.com/about"));
    assert(result.links.includes("https://example.com/docs/getting-started"));
    assert(result.links.includes("https://example.com/docs/intro/deep/page"));
    assert(result.links.includes("https://external.org/resource"));
    assert(result.links.includes("https://example.com/docs/intro/test"));
  });

  it("deduplicates discovered links", () => {
    const html = `
      <a href="/pricing">Pricing 1</a>
      <a href="/pricing#tier-1">Pricing with hash</a>
      <a href="https://example.com/pricing/">Pricing absolute with trailing slash</a>
    `;

    const result = extractHtml(html, baseUrl);

    const pricingLinks = result.links.filter((l) => l === "https://example.com/pricing");
    assert.equal(pricingLinks.length, 1);
  });

  it("ignores non-HTTP schemes, mailto, tel, javascript, and empty links", () => {
    const html = `
      <a href="javascript:void(0)">JS Action</a>
      <a href="mailto:support@example.com">Email Us</a>
      <a href="tel:+18005550199">Call Us</a>
      <a href="data:text/html;base64,PHNjcmlwdD4=">Data URI</a>
      <a href="#anchor-only">Anchor</a>
      <a href="">Empty string</a>
      <a href="   ">Whitespace</a>
      <a>Missing href attribute</a>
      <a href="https://valid.com/page">Valid Link</a>
    `;

    const result = extractHtml(html, baseUrl);

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0], "https://valid.com/page");
  });

  it("handles unquoted attributes and attributes with special characters", () => {
    const html = `
      <a href=/unquoted-target>Unquoted</a>
      <a class="nav-link" href='/single-quote-target' id="link1">Single Quote</a>
      <a href="https://example.com/query?param=1&amp;filter=active">With Encoded Ampersand</a>
    `;

    const result = extractHtml(html, baseUrl);

    assert(result.links.includes("https://example.com/unquoted-target"));
    assert(result.links.includes("https://example.com/single-quote-target"));
    assert(result.links.includes("https://example.com/query?param=1&filter=active"));
  });
});

describe("HTML Extractor - Edge Cases", () => {
  it("handles empty strings and whitespace-only input without crashing", () => {
    const resEmpty = extractHtml("", "https://example.com");
    assert.equal(resEmpty.title, "");
    assert.equal(resEmpty.text, "");
    assert.deepEqual(resEmpty.links, []);

    const resWhitespace = extractHtml("   \n\t   ", "https://example.com");
    assert.equal(resWhitespace.title, "");
    assert.equal(resWhitespace.text, "");
    assert.deepEqual(resWhitespace.links, []);
  });

  it("handles malformed and unclosed tags gracefully", () => {
    const html = `
      <h1>Unclosed Header
      <p>First paragraph without closing p
      <p>Second paragraph < broken tag
      <div>Div content
    `;

    const result = extractHtml(html, "https://example.com");

    assert(result.text.includes("Unclosed Header"));
    assert(result.text.includes("First paragraph without closing p"));
    assert(result.text.includes("Second paragraph"));
    assert(result.text.includes("Div content"));
  });

  it("handles tags containing greater-than signs inside attribute quotes", () => {
    const html = `
      <a href="https://example.com/search?q=1>0">Condition in URL</a>
      <p>Text after tag</p>
    `;

    const result = extractHtml(html, "https://example.com");

    assert(result.text.includes("Condition in URL"));
    assert(result.text.includes("Text after tag"));
    assert.equal(result.links.length, 1);
  });
});
