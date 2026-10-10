import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  InMemoryStorage,
  FileSystemStorage,
  sanitizePathComponent,
  buildFrontmatter,
} from "../src/storage/index.js";
import type { PageRecord, CrawlResponse } from "../src/types/index.js";

const DUMMY_PAGE: PageRecord = {
  url: "https://example.com/test",
  normalizedUrl: "https://example.com/test",
  state: "COMPLETED",
  depth: 1,
  statusCode: 200,
  metadata: {
    title: "Test Page",
    contentHash: "abcdef123456",
    byteSize: 1024,
    isSpa: false,
    usedPlaywright: false,
  },
  markdown: "# Heading\n\nTest content body.",
  outboundLinks: ["https://example.com/other"],
  tookMs: 150,
  timestamp: "2026-10-09T12:00:00.000Z",
};

const DUMMY_CRAWL: CrawlResponse = {
  success: true,
  crawlId: "crawl_test_123",
  stats: {
    totalDiscovered: 1,
    totalCrawled: 1,
    totalFailed: 0,
    totalSkipped: 0,
    totalBytes: 1024,
    durationMs: 300,
  },
  pages: [DUMMY_PAGE],
};

describe("Storage Engines", () => {
  test("InMemoryStorage stores and retrieves crawls and pages", async () => {
    const memory = new InMemoryStorage();
    await memory.saveCrawl(DUMMY_CRAWL);

    const retrieved = await memory.getCrawl("crawl_test_123");
    assert.ok(retrieved);
    assert.equal(retrieved.crawlId, "crawl_test_123");
    assert.equal(retrieved.pages.length, 1);

    const page = await memory.getPage("crawl_test_123", "https://example.com/test");
    assert.ok(page);
    assert.equal(page.metadata.title, "Test Page");
  });

  test("buildFrontmatter generates structured YAML headers with markdown body", () => {
    const output = buildFrontmatter(DUMMY_PAGE);
    assert.ok(output.startsWith("---\n"));
    assert.ok(output.includes('url: "https://example.com/test"'));
    assert.ok(output.includes('title: "Test Page"'));
    assert.ok(output.includes("# Heading\n\nTest content body."));
  });

  test("sanitizePathComponent strips illegal and traversal characters", () => {
    assert.equal(sanitizePathComponent("crawl/../../evil"), "crawl_evil");
    assert.equal(sanitizePathComponent("test\\path:name*?"), "test_path_name_");
  });

  test("FileSystemStorage writes manifest, page JSON, and frontmatter MD", async () => {
    const tempDir = path.join(process.cwd(), "scratch", "test_storage");
    const fsStorage = new FileSystemStorage(tempDir);

    try {
      await fsStorage.saveCrawl(DUMMY_CRAWL);

      const retrieved = await fsStorage.getCrawl("crawl_test_123");
      assert.ok(retrieved);
      assert.equal(retrieved.crawlId, "crawl_test_123");
      assert.equal(retrieved.pages.length, 1);

      const page = await fsStorage.getPage("crawl_test_123", "https://example.com/test");
      assert.ok(page);
      assert.equal(page.metadata.title, "Test Page");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
