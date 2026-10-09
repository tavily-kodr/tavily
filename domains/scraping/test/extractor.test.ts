import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import {
  extractMetadata,
  extractOutboundLinks,
  sanitizeDom,
  selectDenseContent,
  isSpaPage,
  htmlToMarkdown,
  computeContentHash,
  HtmlExtractor,
} from "../src/extractor/index.js";

const SAMPLE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <title>Sample Article - Tavily Blog</title>
  <meta name="description" content="A comprehensive guide to high-performance web crawling.">
  <meta property="og:title" content="OpenGraph Article Title">
  <meta property="og:description" content="OG Description of the guide.">
  <meta property="og:image" content="https://example.com/cover.jpg">
  <link rel="canonical" href="https://example.com/guide">
</head>
<body>
  <header>
    <div class="cookie-banner">Please accept cookies to continue.</div>
    <nav><a href="/home">Home</a> | <a href="/about">About</a></nav>
  </header>
  <main id="content">
    <article class="post">
      <h1>Understanding Modern Web Crawling</h1>
      <p>Web crawling requires dealing with complex HTML, rate limits, robots directives, and SPA rendering.</p>
      <p>Content density algorithms isolate the primary article body while discarding advertising and navigation noise.</p>
      <p>This text is long enough to exceed the 200 character threshold required by the density selector.</p>
      <div class="ad-banner">Buy our product now!</div>
      <p>Further reading can be found at <a href="https://tavily.com/docs">Tavily Documentation</a>.</p>
    </article>
  </main>
  <footer>
    <script>console.log("analytics tracking");</script>
    <style>.ad-banner { display: block; }</style>
  </footer>
</body>
</html>
`;

describe("Extractor Components", () => {
  test("extractMetadata extracts title, description, and OpenGraph tags", () => {
    const $ = load(SAMPLE_HTML);
    const meta = extractMetadata($, "https://example.com/fallback");

    assert.equal(meta.title, "OpenGraph Article Title");
    assert.equal(meta.description, "OG Description of the guide.");
    assert.equal(meta.canonicalUrl, "https://example.com/guide");
    assert.equal(meta.language, "en");
    assert.equal(meta.openGraph["og:image"], "https://example.com/cover.jpg");
  });

  test("extractOutboundLinks captures valid absolute and relative links", () => {
    const $ = load(SAMPLE_HTML);
    const links = extractOutboundLinks($, "https://example.com/blog/article");

    assert.ok(links.includes("https://example.com/home"));
    assert.ok(links.includes("https://example.com/about"));
    assert.ok(links.includes("https://tavily.com/docs"));
  });

  test("sanitizeDom strips scripts, styles, ads, and cookie banners", () => {
    const $ = load(SAMPLE_HTML);
    sanitizeDom($);

    assert.equal($("script").length, 0);
    assert.equal($("style").length, 0);
    assert.equal($(".cookie-banner").length, 0);
    assert.equal($(".ad-banner").length, 0);
  });

  test("selectDenseContent isolates high-density container", () => {
    const $ = load(SAMPLE_HTML);
    sanitizeDom($);
    const selection = selectDenseContent($);

    assert.ok(selection.text.includes("Understanding Modern Web Crawling"));
    assert.ok(
      selection.selectedSelector.includes("main") ||
        selection.selectedSelector.includes("article") ||
        selection.selectedSelector.includes("#content"),
    );
  });

  test("isSpaPage detects single page apps and rejects normal content", () => {
    const spaHtml = '<div id="root"></div><script src="/bundle.js"></script>';
    const $spa = load(spaHtml);
    assert.equal(isSpaPage($spa, 10), true);

    const normal$ = load(SAMPLE_HTML);
    assert.equal(isSpaPage(normal$, 400), false);
  });

  test("htmlToMarkdown converts HTML to clean GFM and computeContentHash is deterministic", () => {
    const html =
      "<h2>Subheading</h2><p>Here is <strong>bold</strong> and <em>italic</em> text.</p>";
    const md = htmlToMarkdown(html);

    assert.ok(md.includes("## Subheading"));
    assert.ok(md.includes("**bold**"));

    const hash1 = computeContentHash(md);
    const hash2 = computeContentHash(md);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // SHA-256 hex length
  });

  test("HtmlExtractor coordinates full extraction pipeline", async () => {
    const extractor = new HtmlExtractor();
    const result = await extractor.extract(SAMPLE_HTML, "https://example.com/guide");

    assert.equal(result.title, "OpenGraph Article Title");
    assert.ok(result.markdown.includes("Understanding Modern Web Crawling"));
    assert.equal(result.metadata.canonicalUrl, "https://example.com/guide");
    assert.equal(result.metadata.contentHash.length, 64);
    assert.ok(result.outboundLinks.length > 0);
  });
});
