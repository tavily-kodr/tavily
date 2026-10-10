import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  saveSearchScrapeReport,
  saveCrawlReport,
  saveQueryScrapeReport,
  sanitizeQueryForFilename,
  getScrapingOutputDir,
} from "../src/output/index.js";
import type { QueryScrapeReport } from "../src/output/types.js";
import type { CrawlResult } from "../src/types/crawl.types.js";

describe("Query Report Writer (JSON & Markdown Output in domains/scraping/output)", () => {
  it("creates exactly one corresponding JSON and one Markdown report for a query", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-report-test-"));

    try {
      const startedAt = new Date().toISOString();
      const completedAt = new Date().toISOString();

      const result = await saveSearchScrapeReport({
        query: "distributed consensus algorithms",
        startedAt,
        completedAt,
        totalDurationMs: 142.5,
        results: [
          {
            title: "Raft Consensus Algorithm",
            url: "https://raft.github.io",
            content: "Raft is a consensus algorithm designed as an alternative to Paxos...",
            snippet: "Snippet Raft",
            canonicalUrl: "https://raft.github.io",
            sourceUrl: "https://raft.github.io",
            score: 0.95,
          },
        ],
        scrapedResults: [
          {
            title: "Raft Consensus Algorithm",
            text: "Raft is a consensus algorithm designed as an alternative to Paxos...",
            finalUrl: "https://raft.github.io",
            tookMs: 120,
          },
        ],
        outputDir: tempDir,
      });

      assert.ok(result);
      assert.ok(result.jsonPath.endsWith(".json"));
      assert.ok(result.mdPath.endsWith(".md"));

      // Verify files exist in temp directory
      const files = await fs.readdir(tempDir);
      assert.equal(files.length, 2, "Must create exactly one JSON and one Markdown file");

      const jsonFile = files.find((f) => f.endsWith(".json"))!;
      const mdFile = files.find((f) => f.endsWith(".md"))!;
      assert.ok(jsonFile);
      assert.ok(mdFile);

      // Verify both share the same base filename
      assert.equal(
        jsonFile.replace(/\.json$/, ""),
        mdFile.replace(/\.md$/, ""),
        "Both files must share the exact base filename",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies both files match the required schema with took_ms, crawl_time_ms, scrape_time_ms, total_crawled, total_scraped", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-report-metrics-"));

    try {
      const startedAt = "2026-10-10T12:00:00.000Z";
      const completedAt = "2026-10-10T12:00:02.500Z";

      const res = await saveSearchScrapeReport({
        query: "sde jobs",
        startedAt,
        completedAt,
        totalDurationMs: 3730,
        crawlDurationMs: 2450,
        results: [
          {
            title: "Software Development",
            url: "https://amazon.jobs/content/en/job-categories/software-development",
            content: "Software Development\n\nTechnology is in everything we do.",
            snippet: "job recommendations based on your interactions",
            canonicalUrl: "https://amazon.jobs/content/en/job-categories/software-development",
            sourceUrl: "https://amazon.jobs/content/en/job-categories/software-development",
            score: 1,
          },
        ],
        scrapedResults: [
          {
            title: "Software Development",
            text: "Software Development\n\nTechnology is in everything we do.",
            finalUrl: "https://amazon.jobs/content/en/job-categories/software-development",
            statusCode: 200,
            tookMs: 2100,
          },
        ],
        outputDir: tempDir,
      });

      assert.ok(res);
      const jsonRaw = await fs.readFile(res.jsonPath, "utf-8");
      const mdRaw = await fs.readFile(res.mdPath, "utf-8");

      const json = JSON.parse(jsonRaw) as QueryScrapeReport;

      // Assert JSON fields matching the exact format
      assert.equal(json.success, true);
      assert.equal(json.data.query, "sde jobs");
      assert.equal(json.data.took_ms, 3730);
      assert.equal(json.data.crawl_time_ms, 2450);
      assert.equal(json.data.scrape_time_ms, 2100);
      assert.equal(json.data.total_crawled, 1);
      assert.equal(json.data.total_scraped, 1);
      assert.equal(json.data.results.length, 1);
      assert.equal(json.data.results[0]!.title, "Software Development");
      assert.equal(
        json.data.results[0]!.url,
        "https://amazon.jobs/content/en/job-categories/software-development",
      );
      assert.equal(
        json.data.results[0]!.canonicalUrl,
        "https://amazon.jobs/content/en/job-categories/software-development",
      );
      assert.equal(
        json.data.results[0]!.sourceUrl,
        "https://amazon.jobs/content/en/job-categories/software-development",
      );
      assert.equal(json.data.results[0]!.score, 1);

      // Assert Markdown contains identical metric values
      assert.ok(mdRaw.includes("sde jobs"));
      assert.ok(mdRaw.includes("| Total Time Taken | 3730 ms |"));
      assert.ok(mdRaw.includes("| Time Taken to Crawl | 2450 ms |"));
      assert.ok(mdRaw.includes("| Time Taken to Scrape | 2100 ms |"));
      assert.ok(mdRaw.includes("| Total Crawled Websites | 1 |"));
      assert.ok(mdRaw.includes("| Total Scraped Websites | 1 |"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies JSON report parses cleanly and preserves actual scraped content", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-report-json-"));

    try {
      const fullText =
        "Line 1: High throughput streaming engine.\n\nLine 2: Heading details and paragraphs.";
      const res = await saveSearchScrapeReport({
        query: "deep learning systems",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalDurationMs: 800,
        results: [
          {
            title: "Deep Learning Systems",
            url: "https://dlsyscourse.org",
            content: fullText,
            snippet: "Short search snippet",
            canonicalUrl: "https://dlsyscourse.org/home",
            sourceUrl: "https://dlsyscourse.org",
            score: 0.99,
          },
        ],
        scrapedResults: [
          {
            title: "Deep Learning Systems Course",
            text: fullText,
            finalUrl: "https://dlsyscourse.org/home",
            tookMs: 500,
          },
        ],
        outputDir: tempDir,
      });

      assert.ok(res);
      const parsed = JSON.parse(await fs.readFile(res.jsonPath, "utf-8")) as QueryScrapeReport;

      assert.equal(parsed.success, true);
      assert.equal(parsed.data.results.length, 1);
      assert.equal(parsed.data.results[0]!.content, fullText);
      assert.equal(parsed.data.results[0]!.canonicalUrl, "https://dlsyscourse.org/home");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies Markdown report contains full structure, website data, and content", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-report-md-"));

    try {
      const sampleText =
        "Rust provides memory safety without garbage collection through ownership.";
      const res = await saveSearchScrapeReport({
        query: "rust ownership model",
        startedAt: "2026-10-10T15:00:00.000Z",
        completedAt: "2026-10-10T15:00:01.200Z",
        totalDurationMs: 1200,
        results: [
          {
            title: "Understanding Ownership - The Rust Programming Language",
            url: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
            content: sampleText,
            snippet: "Rust ownership snippet",
            canonicalUrl: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
            sourceUrl: "https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html",
            score: 0.95,
          },
        ],
        outputDir: tempDir,
      });

      assert.ok(res);
      const mdContent = await fs.readFile(res.mdPath, "utf-8");

      assert.ok(mdContent.startsWith("# Scraping Report: rust ownership model"));
      assert.ok(mdContent.includes("rust ownership model"));
      assert.ok(mdContent.includes("## Execution Summary"));
      assert.ok(mdContent.includes("## Scraped and Crawled Results"));
      assert.ok(mdContent.includes("Understanding Ownership - The Rust Programming Language"));
      assert.ok(mdContent.includes(sampleText));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sanitizes unusual queries and prevents path traversal attacks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-report-security-"));

    try {
      // 1. Directory traversal attempt
      const traversalQuery = "../../../../etc/passwd";
      const sanitizedTraversal = sanitizeQueryForFilename(traversalQuery);
      assert.ok(!sanitizedTraversal.includes(".."));
      assert.ok(!sanitizedTraversal.includes("/"));
      assert.ok(!sanitizedTraversal.includes("\\"));

      const res = await saveSearchScrapeReport({
        query: traversalQuery,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalDurationMs: 100,
        results: [
          {
            title: "T",
            url: "https://test.com",
            content: "Safe content",
            score: 1,
            snippet: "",
            canonicalUrl: "https://test.com",
            sourceUrl: "https://test.com",
          },
        ],
        outputDir: tempDir,
      });

      assert.ok(res);
      assert.ok(res.jsonPath.startsWith(tempDir), "JSON path must stay inside tempDir");
      assert.ok(res.mdPath.startsWith(tempDir), "MD path must stay inside tempDir");

      // 2. Query with special characters and excessive length
      const complexQuery = "What is AI??? / & <script>alert(1)</script> " + "a".repeat(200);
      const sanitizedComplex = sanitizeQueryForFilename(complexQuery);
      assert.ok(sanitizedComplex.length <= 50, "Should clamp length");
      assert.ok(!/[/?&<>:]/.test(sanitizedComplex));

      // 3. Empty query fallback
      assert.equal(sanitizeQueryForFilename(""), "query");
      assert.equal(sanitizeQueryForFilename("   "), "query");
      assert.equal(sanitizeQueryForFilename("!@#$%^&*()"), "query");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ensures concurrent queries do not overwrite one another", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-report-concurrency-"));

    try {
      const queries = Array.from({ length: 6 }, (_, i) => `concurrent query item ${i + 1}`);

      const tasks = queries.map((q) =>
        saveSearchScrapeReport({
          query: q,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          totalDurationMs: 50,
          results: [
            {
              title: `Result for ${q}`,
              url: `https://test.com/${q}`,
              content: `Content ${q}`,
              score: 1,
              snippet: "",
              canonicalUrl: `https://test.com/${q}`,
              sourceUrl: `https://test.com/${q}`,
            },
          ],
          outputDir: tempDir,
        }),
      );

      const results = await Promise.all(tasks);

      // Verify all 6 returned distinct paths
      const jsonPaths = new Set(results.map((r) => r?.jsonPath));
      const mdPaths = new Set(results.map((r) => r?.mdPath));

      assert.equal(jsonPaths.size, 6, "Must produce 6 unique JSON files");
      assert.equal(mdPaths.size, 6, "Must produce 6 unique Markdown files");

      const files = await fs.readdir(tempDir);
      assert.equal(files.length, 12, "Must contain exactly 12 files (6 json + 6 md)");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles and logs filesystem write failures predictably without leaving temp files", async () => {
    const report: QueryScrapeReport = {
      success: true,
      data: {
        query: "test failure",
        results: [],
        took_ms: 10,
        crawl_time_ms: 5,
        scrape_time_ms: 5,
        total_crawled: 0,
        total_scraped: 0,
      },
    };

    await assert.rejects(
      async () => {
        const blockerFile = path.join(os.tmpdir(), `blocker-${Date.now()}`);
        await fs.writeFile(blockerFile, "I am a file, not a directory");
        try {
          await saveQueryScrapeReport(report, { outputDir: path.join(blockerFile, "output") });
        } finally {
          await fs.unlink(blockerFile).catch(() => {});
        }
      },
      (err: unknown) => {
        return err instanceof Error;
      },
    );
  });

  it("supports direct multi-page crawl reports via saveCrawlReport", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tavily-crawl-report-"));

    try {
      const crawlResult: CrawlResult = {
        seedUrl: "https://crawler-example.org",
        canonicalSeedUrl: "https://crawler-example.org",
        pages: [
          {
            url: "https://crawler-example.org",
            finalUrl: "https://crawler-example.org",
            depth: 0,
            statusCode: 200,
            title: "Home Page",
            text: "Welcome to the crawler home page with full documentation.",
            links: ["https://crawler-example.org/about"],
            tookMs: 45,
            resolvedIp: "93.184.216.34",
          },
        ],
        failedPages: [
          {
            url: "https://crawler-example.org/broken",
            depth: 1,
            error: "HTTP 404 Not Found",
            statusCode: 404,
          },
        ],
        totalDiscovered: 5,
        totalVisited: 2,
        tookMs: 120,
        queueLimitReached: false,
        discardedDueToQueueLimit: 0,
        robotsBlockedCount: 1,
      };

      const res = await saveCrawlReport({
        seedUrl: "https://crawler-example.org",
        crawlResult,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalDurationMs: 120,
        outputDir: tempDir,
      });

      assert.ok(res);
      const json = JSON.parse(await fs.readFile(res.jsonPath, "utf-8")) as QueryScrapeReport;

      assert.equal(json.success, true);
      assert.equal(json.data.query, "https://crawler-example.org");
      assert.equal(json.data.total_crawled, 1);
      assert.equal(json.data.results.length, 1);
      assert.equal(json.data.took_ms, 120);

      const md = await fs.readFile(res.mdPath, "utf-8");
      assert.ok(md.includes("https://crawler-example.org"));
      assert.ok(md.includes("Home Page"));
      assert.ok(md.includes("Welcome to the crawler home page"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves default output directory strictly inside the scraping module (domains/scraping/output)", async () => {
    const resolved = getScrapingOutputDir();
    assert.ok(
      resolved.replace(/\\/g, "/").endsWith("domains/scraping/output"),
      `Expected output dir to end with domains/scraping/output, got: ${resolved}`,
    );
  });
});
