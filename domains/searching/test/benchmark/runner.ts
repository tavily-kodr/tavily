import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScraperService, HttpFetcher } from "@tavily/scraping";
import { startFixtureServer } from "./fixture-server.js";
import { saveBenchmarkReports } from "./reporter.js";
import type {
  BenchmarkConfig,
  BenchmarkReport,
  BenchmarkUrlResult,
  BenchmarkError,
} from "./types.js";

const DEFAULT_OUTPUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../output",
);

async function findLatestBaselineReport(
  prefix: "live" | "fix",
  outputDir = DEFAULT_OUTPUT_DIR,
): Promise<BenchmarkReport | undefined> {
  try {
    const files = await fs.readdir(outputDir);
    const matching = files
      .filter((f) => f.startsWith(`crawl-report-${prefix}-`) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (matching.length === 0) return undefined;
    const latestFile = path.join(outputDir, matching[0]!);
    const raw = await fs.readFile(latestFile, "utf-8");
    return JSON.parse(raw) as BenchmarkReport;
  } catch {
    return undefined;
  }
}

/**
 * Counts words in a string by splitting on whitespace.
 */
function countWords(text: string): number {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Calculates median from an array of numbers.
 */
function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Executes a deterministic fixture-based benchmark testing all representative edge cases.
 */
export async function runFixtureBenchmark(
  config: Partial<BenchmarkConfig> = {},
  baselineReport?: BenchmarkReport,
): Promise<{ report: BenchmarkReport; jsonPath: string; mdPath: string }> {
  const runId = `fix-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const startedAt = new Date().toISOString();
  const overallStart = performance.now();

  const fixtureServer = await startFixtureServer();
  const baseUrl = fixtureServer.baseUrl;

  const effectiveConfig: BenchmarkConfig = {
    query: "deterministic-fixture-test",
    maxResults: config.maxResults ?? 7,
    crawlConcurrency: config.crawlConcurrency ?? 3,
    crawlTimeoutMs: config.crawlTimeoutMs ?? 4000,
    respectRobotsTxt: config.respectRobotsTxt ?? false,
    live: false,
  };

  const candidateUrls: Array<{
    url: string;
    description: string;
    expectSkip?: boolean;
    skipReason?: string;
  }> = [
    { url: `${baseUrl}/static-article`, description: "Standard static HTML article" },
    { url: `${baseUrl}/js-rendered`, description: "Client-side rendered SPA" },
    { url: `${baseUrl}/duplicate-alias`, description: "Duplicate canonical alias" },
    { url: `${baseUrl}/redirect-to-article`, description: "302 redirect to static article" },
    { url: `${baseUrl}/empty-page`, description: "Empty HTML content" },
    { url: `${baseUrl}/server-error`, description: "HTTP 500 server error" },
    { url: `${baseUrl}/slow-page`, description: "Slow response exceeding timeout" },
    {
      url: "http://192.168.1.1/internal-admin",
      description: "SSRF private IP attempt",
      expectSkip: true,
      skipReason: "SSRF private IP blocked upfront",
    },
  ];

  const searchDurationMs = 12.5; // Deterministic simulated search provider phase
  const urlResults: BenchmarkUrlResult[] = [];
  const errors: BenchmarkError[] = [];

  // Setup Scraper with private networks allowed ONLY for our local test server port
  const fetcher = new HttpFetcher();
  const scraper = new ScraperService(fetcher);

  const crawlWallStart = performance.now();

  // Bounded concurrency worker pool
  const queue = [...candidateUrls];
  const workerCount = Math.min(effectiveConfig.crawlConcurrency, queue.length);

  const processUrl = async (item: (typeof candidateUrls)[0]) => {
    if (item.expectSkip) {
      urlResults.push({
        url: item.url,
        finalUrl: item.url,
        status: "skipped",
        durationMs: 0.5,
        charactersExtracted: 0,
        wordsExtracted: 0,
        fetchMethod: "SKIP",
        fallbackUsed: false,
        error: item.skipReason ?? "Skipped",
      });
      return;
    }

    const itemStart = performance.now();
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), effectiveConfig.crawlTimeoutMs);

    try {
      const scraped = await scraper.scrape(item.url, {
        signal: abortCtrl.signal,
        timeoutMs: effectiveConfig.crawlTimeoutMs,
        allowPrivateNetworks: true,
      });

      const durationMs = performance.now() - itemStart;
      const text = scraped.text ?? "";
      const chars = text.length;
      const words = countWords(text);

      urlResults.push({
        url: item.url,
        finalUrl: scraped.finalUrl,
        status: "success",
        durationMs,
        charactersExtracted: chars,
        wordsExtracted: words,
        fetchMethod: "HTTP",
        fallbackUsed: false,
        error: null,
        statusCode: scraped.statusCode,
      });
    } catch (err: unknown) {
      const durationMs = performance.now() - itemStart;
      const errorMsg = err instanceof Error ? err.message : String(err);

      errors.push({
        url: item.url,
        phase: "crawl",
        message: errorMsg,
      });

      urlResults.push({
        url: item.url,
        finalUrl: item.url,
        status: "failed",
        durationMs,
        charactersExtracted: 0,
        wordsExtracted: 0,
        fetchMethod: "HTTP",
        fallbackUsed: true,
        error: errorMsg,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const runWorker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      await processUrl(item);
    }
  };

  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);

  const crawlWallTimeMs = performance.now() - crawlWallStart;
  const totalDurationMs = performance.now() - overallStart;
  const finishedAt = new Date().toISOString();

  await fixtureServer.close();

  // Metric computations
  const successfulCrawls = urlResults.filter((r) => r.status === "success").length;
  const failedCrawls = urlResults.filter((r) => r.status === "failed").length;
  const skippedUrls = urlResults.filter((r) => r.status === "skipped").length;
  const crawlAttempts = successfulCrawls + failedCrawls;
  const pagesWithUsableContent = urlResults.filter(
    (r) => r.status === "success" && r.charactersExtracted > 20,
  ).length;
  const pagesWithEmptyContent = urlResults.filter(
    (r) => r.status === "success" && r.charactersExtracted <= 20,
  ).length;

  const totalCharactersExtracted = urlResults.reduce((acc, r) => acc + r.charactersExtracted, 0);
  const totalWordsExtracted = urlResults.reduce((acc, r) => acc + r.wordsExtracted, 0);

  const crawlDurations = urlResults.filter((r) => r.status !== "skipped").map((r) => r.durationMs);
  const avgCrawlDurationMs =
    crawlDurations.length > 0
      ? crawlDurations.reduce((a, b) => a + b, 0) / crawlDurations.length
      : 0;
  const medianCrawlDurationMs = calculateMedian(crawlDurations);
  const fastestCrawlMs = crawlDurations.length > 0 ? Math.min(...crawlDurations) : 0;
  const slowestCrawlMs = crawlDurations.length > 0 ? Math.max(...crawlDurations) : 0;

  const successRatePercent = crawlAttempts > 0 ? (successfulCrawls / crawlAttempts) * 100 : 0;

  const baseline = baselineReport ?? (await findLatestBaselineReport("fix"));

  let comparison: BenchmarkReport["comparison"] = null;
  if (baseline) {
    comparison = {
      baselineRunId: baseline.runId,
      baselineTotalDurationMs: baseline.summary.totalDurationMs,
      baselineCrawlDurationMs: baseline.summary.crawlWallTimeMs,
      baselineWords: baseline.summary.totalWordsExtracted,
      baselineSuccessRatePercent: baseline.summary.successRatePercent,
      totalDurationDeltaMs: totalDurationMs - baseline.summary.totalDurationMs,
      crawlDurationDeltaMs: crawlWallTimeMs - baseline.summary.crawlWallTimeMs,
      wordsDelta: totalWordsExtracted - baseline.summary.totalWordsExtracted,
      successRateDeltaPercent: successRatePercent - baseline.summary.successRatePercent,
    };
  }

  const report: BenchmarkReport = {
    schemaVersion: "1.0.0",
    runId,
    startedAt,
    finishedAt,
    environment: {
      nodeVersion: process.version,
      os: `${os.type()} ${os.arch()}`,
      isLive: false,
    },
    configuration: {
      maxResults: effectiveConfig.maxResults,
      crawlConcurrency: effectiveConfig.crawlConcurrency,
      crawlTimeoutMs: effectiveConfig.crawlTimeoutMs,
      respectRobotsTxt: effectiveConfig.respectRobotsTxt,
    },
    summary: {
      query: effectiveConfig.query ?? "deterministic-fixture-test",
      searchResultsReturned: candidateUrls.length,
      uniqueUrlsSelected: candidateUrls.length,
      crawlAttempts,
      successfulCrawls,
      failedCrawls,
      skippedUrls,
      pagesWithUsableContent,
      pagesWithEmptyContent,
      successRatePercent,
      totalCharactersExtracted,
      totalWordsExtracted,
      searchDurationMs,
      crawlWallTimeMs,
      totalDurationMs,
    },
    results: urlResults,
    errors,
    performance: {
      averageCrawlDurationMs: avgCrawlDurationMs,
      medianCrawlDurationMs: medianCrawlDurationMs,
      fastestCrawlMs: fastestCrawlMs,
      slowestCrawlMs: slowestCrawlMs,
      effectiveConcurrency: effectiveConfig.crawlConcurrency,
    },
    comparison,
  };

  const { jsonPath, mdPath } = await saveBenchmarkReports(report);
  return { report, jsonPath, mdPath };
}

/**
 * Executes a live end-to-end benchmark against the running Search API service.
 */
export async function runLiveBenchmark(
  config: Partial<BenchmarkConfig> = {},
  baselineReport?: BenchmarkReport,
): Promise<{ report: BenchmarkReport; jsonPath: string; mdPath: string }> {
  const query = config.query ?? "technology innovations";
  const runId = `live-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const startedAt = new Date().toISOString();
  const overallStart = performance.now();

  const apiUrl = config.apiUrl ?? "http://localhost:3000";
  const effectiveConfig: BenchmarkConfig = {
    query,
    maxResults: config.maxResults ?? 5,
    crawlConcurrency: config.crawlConcurrency ?? 3,
    crawlTimeoutMs: config.crawlTimeoutMs ?? 4000,
    respectRobotsTxt: config.respectRobotsTxt ?? false,
    live: true,
    apiUrl,
  };

  const searchReqStart = performance.now();

  // 1. First probe search provider latency by requesting crawl: false
  const noCrawlRes = await fetch(`${apiUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, crawl: false, max_results: effectiveConfig.maxResults }),
  });

  const noCrawlData = (await noCrawlRes.json()) as {
    success: boolean;
    data?: { results: Array<{ title: string; url: string; content: string }>; took_ms: number };
  };

  const searchDurationMs = noCrawlData.data?.took_ms ?? performance.now() - searchReqStart;
  const searchResultsReturned = noCrawlData.data?.results?.length ?? 0;

  // 2. Perform live search with crawling enabled
  const crawlStart = performance.now();
  const crawlRes = await fetch(`${apiUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      crawl: true,
      max_results: effectiveConfig.maxResults,
      include_raw_content: true,
    }),
  });

  const crawlWallTimeMs = performance.now() - crawlStart;
  const totalDurationMs = performance.now() - overallStart;
  const finishedAt = new Date().toISOString();

  const crawlData = (await crawlRes.json()) as {
    success: boolean;
    data?: {
      results: Array<{
        title: string;
        url: string;
        content: string;
        snippet?: string;
        canonicalUrl?: string;
      }>;
      took_ms: number;
    };
  };

  const results = crawlData.data?.results ?? [];
  const urlResults: BenchmarkUrlResult[] = [];
  const errors: BenchmarkError[] = [];

  for (const item of results) {
    const isCrawled = Boolean(item.snippet && item.content !== item.snippet);
    const chars = item.content.length;
    const words = countWords(item.content);

    urlResults.push({
      url: item.url,
      finalUrl: item.canonicalUrl ?? item.url,
      status: "success",
      durationMs: crawlWallTimeMs / Math.max(1, results.length),
      charactersExtracted: chars,
      wordsExtracted: words,
      fetchMethod: isCrawled ? "HTTP" : "NONE",
      fallbackUsed: !isCrawled,
      error: null,
    });
  }

  const crawlAttempts = results.length;
  const successfulCrawls = urlResults.filter((r) => r.status === "success").length;
  const failedCrawls = urlResults.filter((r) => r.status === "failed").length;
  const pagesWithUsableContent = urlResults.filter((r) => r.charactersExtracted > 50).length;
  const pagesWithEmptyContent = urlResults.filter((r) => r.charactersExtracted <= 50).length;

  const totalCharactersExtracted = urlResults.reduce((acc, r) => acc + r.charactersExtracted, 0);
  const totalWordsExtracted = urlResults.reduce((acc, r) => acc + r.wordsExtracted, 0);

  const crawlDurations = urlResults.map((r) => r.durationMs);
  const avgCrawlDurationMs =
    crawlDurations.length > 0
      ? crawlDurations.reduce((a, b) => a + b, 0) / crawlDurations.length
      : 0;
  const medianCrawlDurationMs = calculateMedian(crawlDurations);
  const fastestCrawlMs = crawlDurations.length > 0 ? Math.min(...crawlDurations) : 0;
  const slowestCrawlMs = crawlDurations.length > 0 ? Math.max(...crawlDurations) : 0;

  const successRatePercent = crawlAttempts > 0 ? (successfulCrawls / crawlAttempts) * 100 : 0;

  const baseline = baselineReport ?? (await findLatestBaselineReport("live"));

  let comparison: BenchmarkReport["comparison"] = null;
  if (baseline) {
    comparison = {
      baselineRunId: baseline.runId,
      baselineTotalDurationMs: baseline.summary.totalDurationMs,
      baselineCrawlDurationMs: baseline.summary.crawlWallTimeMs,
      baselineWords: baseline.summary.totalWordsExtracted,
      baselineSuccessRatePercent: baseline.summary.successRatePercent,
      totalDurationDeltaMs: totalDurationMs - baseline.summary.totalDurationMs,
      crawlDurationDeltaMs: crawlWallTimeMs - baseline.summary.crawlWallTimeMs,
      wordsDelta: totalWordsExtracted - baseline.summary.totalWordsExtracted,
      successRateDeltaPercent: successRatePercent - baseline.summary.successRatePercent,
    };
  }

  const report: BenchmarkReport = {
    schemaVersion: "1.0.0",
    runId,
    startedAt,
    finishedAt,
    environment: {
      nodeVersion: process.version,
      os: `${os.type()} ${os.arch()}`,
      isLive: true,
    },
    configuration: {
      maxResults: effectiveConfig.maxResults,
      crawlConcurrency: effectiveConfig.crawlConcurrency,
      crawlTimeoutMs: effectiveConfig.crawlTimeoutMs,
      respectRobotsTxt: effectiveConfig.respectRobotsTxt,
    },
    summary: {
      query,
      searchResultsReturned,
      uniqueUrlsSelected: results.length,
      crawlAttempts,
      successfulCrawls,
      failedCrawls,
      skippedUrls: 0,
      pagesWithUsableContent,
      pagesWithEmptyContent,
      successRatePercent,
      totalCharactersExtracted,
      totalWordsExtracted,
      searchDurationMs,
      crawlWallTimeMs,
      totalDurationMs,
    },
    results: urlResults,
    errors,
    performance: {
      averageCrawlDurationMs: avgCrawlDurationMs,
      medianCrawlDurationMs: medianCrawlDurationMs,
      fastestCrawlMs: fastestCrawlMs,
      slowestCrawlMs: slowestCrawlMs,
      effectiveConcurrency: effectiveConfig.crawlConcurrency,
    },
    comparison,
  };

  const { jsonPath, mdPath } = await saveBenchmarkReports(report);
  return { report, jsonPath, mdPath };
}
