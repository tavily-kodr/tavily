import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AppError } from "@tavily/errors";
import { ScraperService } from "../src/services/scraper.service.js";

function startTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        server,
        url,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("ScraperService - Single-Page Scraping", () => {
  it("scrapes a webpage, extracts clean text, metadata, and outgoing links with timing", async () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Scraper Test Page</title>
          <meta name="description" content="This is a test description for scraping service.">
          <link rel="canonical" href="/canonical-page">
        </head>
        <body>
          <header><p>Header to exclude</p></header>
          <nav><a href="/nav-item">Nav Link</a></nav>
          <main>
            <h1>Main Title</h1>
            <p>First paragraph with <a href="/article-1">an internal link</a>.</p>
            <p>Second paragraph with <a href="https://external.org/test">an external link</a>.</p>
          </main>
          <footer><p>Footer to exclude</p></footer>
        </body>
      </html>
    `;

    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(sampleHtml);
    });

    try {
      const scraper = new ScraperService();
      const result = await scraper.scrape(url, { allowPrivateNetworks: true });

      assert.equal(result.statusCode, 200);
      assert.equal(result.requestedUrl, url);
      assert.equal(result.finalUrl, url);
      assert.equal(result.title, "Scraper Test Page");
      assert.equal(result.description, "This is a test description for scraping service.");
      assert.equal(result.canonicalUrl, `${url}/canonical-page`);
      assert.equal(result.language, "en");

      // Verify clean text: header and footer excluded, main content included
      assert(result.text.includes("Main Title"));
      assert(result.text.includes("First paragraph with an internal link."));
      assert.equal(result.text.includes("Header to exclude"), false);
      assert.equal(result.text.includes("Footer to exclude"), false);

      // Verify links discovered and resolved
      assert(result.links.includes(`${url}/nav-item`));
      assert(result.links.includes(`${url}/article-1`));
      assert(result.links.includes("https://external.org/test"));

      // Verify high-resolution execution timing
      assert(typeof result.tookMs === "number");
      assert(result.tookMs >= 0);
    } finally {
      await close();
    }
  });

  it("propagates typed AppError when upstream returns 404", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>Page Not Found</h1>");
    });

    try {
      const scraper = new ScraperService();
      await assert.rejects(
        async () => scraper.scrape(url, { allowPrivateNetworks: true }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "HTTP_ERROR");
          assert.equal(err.statusCode, 404);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("propagates typed AppError when response is not HTML", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not html" }));
    });

    try {
      const scraper = new ScraperService();
      await assert.rejects(
        async () => scraper.scrape(url, { allowPrivateNetworks: true }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "UNSUPPORTED_CONTENT_TYPE");
          assert.equal(err.statusCode, 415);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("rejects SSRF targeting private address by default", async () => {
    const scraper = new ScraperService();
    await assert.rejects(
      async () => scraper.scrape("http://127.0.0.1:8080/private"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });
});
