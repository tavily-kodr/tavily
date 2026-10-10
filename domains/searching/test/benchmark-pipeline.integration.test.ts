import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFixtureBenchmark } from "./benchmark/runner.js";
import { formatMarkdownReport } from "./benchmark/reporter.js";

describe("Benchmark & Crawling Pipeline Verification Suite", () => {
  it("verifies deterministic fixture benchmark execution and report schema validity", async () => {
    const { report } = await runFixtureBenchmark({
      maxResults: 7,
      crawlConcurrency: 3,
      crawlTimeoutMs: 3000,
    });

    // 1. Schema version and identifiers
    assert.equal(report.schemaVersion, "1.0.0");
    assert.ok(report.runId.startsWith("fix-"));
    assert.ok(report.startedAt);
    assert.ok(report.finishedAt);

    // 2. Metrics separation
    assert.equal(report.summary.searchResultsReturned, 8);
    assert.equal(report.summary.uniqueUrlsSelected, 8);
    assert.equal(report.summary.crawlAttempts, 7);
    assert.equal(report.summary.skippedUrls, 1); // SSRF private IP skipped
    assert.equal(report.summary.successfulCrawls, 5);
    assert.equal(report.summary.failedCrawls, 2); // 500 server error + slow page timeout

    // 3. Usable content detection
    assert.equal(report.summary.pagesWithUsableContent, 4);
    assert.equal(report.summary.pagesWithEmptyContent, 1); // empty-page has 0 chars
    assert.ok(report.summary.totalWordsExtracted > 50);

    // 4. Mathematical consistency of timings and rates
    assert.ok(report.summary.totalDurationMs >= report.summary.crawlWallTimeMs);
    assert.ok(report.summary.crawlWallTimeMs >= 3000, "Should wait for timeout on slow page");
    assert.ok(report.performance.fastestCrawlMs <= report.performance.slowestCrawlMs);
    assert.equal(
      report.summary.successRatePercent,
      (report.summary.successfulCrawls / report.summary.crawlAttempts) * 100,
    );

    // 5. Per-URL status and fallback verification
    const staticArticle = report.results.find((r) => r.url.includes("/static-article"));
    assert.ok(staticArticle);
    assert.equal(staticArticle.status, "success");
    assert.ok(staticArticle.charactersExtracted > 100);
    assert.equal(staticArticle.fallbackUsed, false);

    const emptyPage = report.results.find((r) => r.url.includes("/empty-page"));
    assert.ok(emptyPage);
    assert.equal(emptyPage.status, "success");
    assert.equal(emptyPage.charactersExtracted, 0);

    const serverError = report.results.find((r) => r.url.includes("/server-error"));
    assert.ok(serverError);
    assert.equal(serverError.status, "failed");
    assert.equal(serverError.fallbackUsed, true);
    assert.ok(serverError.error?.includes("500"));

    const slowPage = report.results.find((r) => r.url.includes("/slow-page"));
    assert.ok(slowPage);
    assert.equal(slowPage.status, "failed");
    assert.equal(slowPage.fallbackUsed, true);

    const ssrfUrl = report.results.find((r) => r.url.includes("192.168.1.1"));
    assert.ok(ssrfUrl);
    assert.equal(ssrfUrl.status, "skipped");
    assert.equal(ssrfUrl.fetchMethod, "SKIP");

    // 6. Redirect canonical resolution
    const redirectPage = report.results.find((r) => r.url.includes("/redirect-to-article"));
    assert.ok(redirectPage);
    assert.equal(redirectPage.status, "success");
    assert.ok(redirectPage.finalUrl.endsWith("/static-article"));
  });

  it("verifies Markdown report formatting contains truthful matching counts", async () => {
    const { report } = await runFixtureBenchmark({
      maxResults: 7,
      crawlConcurrency: 3,
      crawlTimeoutMs: 2000,
    });

    const md = formatMarkdownReport(report);

    assert.ok(md.includes(`# Crawl & Search Benchmark Report`));
    assert.ok(md.includes(report.runId));
    assert.ok(md.includes(`Total End-to-End Latency`));
    assert.ok(md.includes("Candidate URLs Selected"));
    assert.ok(md.includes(String(report.summary.uniqueUrlsSelected)));
    assert.ok(md.includes("Successful Fetches"));
    assert.ok(md.includes(String(report.summary.successfulCrawls)));
    assert.ok(md.includes("Total Text Extracted"));
    assert.ok(
      md.includes("| Target URL | Status | Latency | Chars | Words | Fetch Method | Fallback? |"),
    );
  });
});
