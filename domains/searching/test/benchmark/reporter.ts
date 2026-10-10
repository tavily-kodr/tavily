import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkReport } from "./types.js";

const DEFAULT_OUTPUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../output",
);

/**
 * Saves both JSON and human-readable Markdown reports to the output/ directory in repository root.
 */
export async function saveBenchmarkReports(
  report: BenchmarkReport,
  outputDir = DEFAULT_OUTPUT_DIR,
): Promise<{ jsonPath: string; mdPath: string }> {
  await fs.mkdir(outputDir, { recursive: true });

  const jsonFileName = `crawl-report-${report.runId}.json`;
  const mdFileName = `crawl-report-${report.runId}.md`;

  const jsonPath = path.join(outputDir, jsonFileName);
  const mdPath = path.join(outputDir, mdFileName);

  // 1. Write JSON Report
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");

  // 2. Format Markdown Report
  const mdContent = formatMarkdownReport(report);
  await fs.writeFile(mdPath, mdContent, "utf-8");

  return { jsonPath, mdPath };
}

export function formatMarkdownReport(report: BenchmarkReport): string {
  const { summary, performance, configuration, results, errors, comparison } = report;

  const failureRows = results
    .filter((r) => r.status === "failed" || r.status === "skipped")
    .map(
      (r) => `| \`${r.url}\` | ${r.status} | ${r.error || "N/A"} | ${r.durationMs.toFixed(1)} ms |`,
    )
    .join("\n");

  const resultsTable = results
    .map(
      (r) =>
        `| \`${r.url}\` | ${r.status === "success" ? "✅ Success" : r.status === "failed" ? "❌ Failed" : "⚠️ Skipped"} | ${r.durationMs.toFixed(1)} ms | ${r.charactersExtracted.toLocaleString()} | ${r.wordsExtracted.toLocaleString()} | ${r.fetchMethod} | ${r.fallbackUsed ? "Yes" : "No"} |`,
    )
    .join("\n");

  const slowestUrls = [...results]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map(
      (r, idx) => `${idx + 1}. \`${r.url}\` (${r.durationMs.toFixed(1)} ms) - Status: ${r.status}`,
    )
    .join("\n");

  let comparisonSection = "";
  if (comparison) {
    const baseDuration =
      comparison.baselineTotalDurationMs != null
        ? `${comparison.baselineTotalDurationMs.toFixed(1)} ms`
        : "-";
    const baseCrawlTime =
      comparison.baselineCrawlDurationMs != null
        ? `${comparison.baselineCrawlDurationMs.toFixed(1)} ms`
        : "-";
    const baseWords =
      comparison.baselineWords != null ? comparison.baselineWords.toLocaleString() : "-";
    const baseSuccessRate =
      comparison.baselineSuccessRatePercent != null
        ? `${comparison.baselineSuccessRatePercent.toFixed(1)}%`
        : "-";

    comparisonSection = `
## Baseline Comparison

| Metric | Baseline (\`${comparison.baselineRunId}\`) | Current (\`${report.runId}\`) | Delta |
|---|---|---|---|
| **Total Duration** | ${baseDuration} | ${summary.totalDurationMs.toFixed(1)} ms | ${comparison.totalDurationDeltaMs >= 0 ? "+" : ""}${comparison.totalDurationDeltaMs.toFixed(1)} ms |
| **Crawl Wall Time** | ${baseCrawlTime} | ${summary.crawlWallTimeMs.toFixed(1)} ms | ${comparison.crawlDurationDeltaMs >= 0 ? "+" : ""}${comparison.crawlDurationDeltaMs.toFixed(1)} ms |
| **Words Extracted** | ${baseWords} | ${summary.totalWordsExtracted.toLocaleString()} | ${comparison.wordsDelta >= 0 ? "+" : ""}${comparison.wordsDelta.toLocaleString()} |
| **Success Rate** | ${baseSuccessRate} | ${summary.successRatePercent.toFixed(1)}% | ${comparison.successRateDeltaPercent >= 0 ? "+" : ""}${comparison.successRateDeltaPercent.toFixed(1)}% |
`;
  }

  return `# Crawl & Search Benchmark Report

**Run ID**: \`${report.runId}\`  
**Generated At**: ${report.startedAt}  
**Environment**: Node ${report.environment.nodeVersion} (${report.environment.os}) | Mode: ${report.environment.isLive ? "Live Production / Cluster" : "Deterministic Local Fixtures"}  
**Schema Version**: \`${report.schemaVersion}\`

---

## Executive Summary

- **Query**: \`${summary.query}\`
- **Total End-to-End Latency**: **${summary.totalDurationMs.toFixed(1)} ms**
- **Search Provider Latency**: **${summary.searchDurationMs.toFixed(1)} ms**
- **Crawl Wall-Clock Latency**: **${summary.crawlWallTimeMs.toFixed(1)} ms**
- **Candidate URLs Selected**: **${summary.uniqueUrlsSelected}** (from ${summary.searchResultsReturned} search results)
- **Crawl Attempts**: **${summary.crawlAttempts}**
- **Successful Fetches**: **${summary.successfulCrawls}** (${summary.successRatePercent.toFixed(1)}% success rate)
- **Pages Yielding Usable Content**: **${summary.pagesWithUsableContent}**
- **Total Text Extracted**: **${summary.totalWordsExtracted.toLocaleString()} words** (${summary.totalCharactersExtracted.toLocaleString()} chars)

---

## Core Questions Answered

1. **How many links did the search engine find?**  
   ${summary.searchResultsReturned} links were returned by the upstream search provider.

2. **How many unique links did we attempt to crawl?**  
   ${summary.crawlAttempts} candidate links were attempted (filtered from ${summary.uniqueUrlsSelected} selected candidates).

3. **How many pages were fetched successfully?**  
   ${summary.successfulCrawls} pages returned HTTP 2xx successfully.

4. **How many pages produced usable content?**  
   ${summary.pagesWithUsableContent} pages contained non-empty semantic text (${summary.pagesWithEmptyContent} pages had empty content).

5. **How long did the entire query take?**  
   ${summary.totalDurationMs.toFixed(1)} ms total elapsed wall-clock time.

6. **Which URLs consumed the most time?**  
${slowestUrls || "None"}

7. **What failed, and why?**  
   ${summary.failedCrawls === 0 ? "No crawl attempts failed." : `${summary.failedCrawls} crawl attempts failed.`}  
   ${summary.skippedUrls} URLs were skipped upfront (SSRF protection, invalid schemes, or duplicate canonical destinations).

8. **Did this run preserve extraction quality?**  
   Extracted ${summary.totalWordsExtracted.toLocaleString()} words across ${summary.pagesWithUsableContent} usable pages.

---

## Stage-by-Stage Performance & Concurrency

| Metric | Measured Value | Notes |
|---|---|---|
| **Search Stage** | ${summary.searchDurationMs.toFixed(1)} ms | Query upstream search provider & parse candidate metadata |
| **Crawl Wall Time** | ${summary.crawlWallTimeMs.toFixed(1)} ms | Parallel crawling of selected candidates |
| **Effective Concurrency** | ${performance.effectiveConcurrency} | Max concurrent workers configured: \`${configuration.crawlConcurrency}\` |
| **Average Crawl Duration** | ${performance.averageCrawlDurationMs.toFixed(1)} ms | Per-URL arithmetic mean |
| **Median Crawl Duration** | ${performance.medianCrawlDurationMs.toFixed(1)} ms | Per-URL median latency |
| **Fastest Crawl** | ${performance.fastestCrawlMs.toFixed(1)} ms | Fastest single candidate fetch |
| **Slowest Crawl** | ${performance.slowestCrawlMs.toFixed(1)} ms | Slowest single candidate fetch |
| **Crawl Timeout Limit** | ${configuration.crawlTimeoutMs} ms | Hard deadline per crawl request |

---

## Per-URL Results Table

| Target URL | Status | Latency | Chars | Words | Fetch Method | Fallback? |
|---|---|---|---|---|---|---|
${resultsTable}

---

## Failure & Anomaly Breakdown

${failureRows ? `| URL | Status | Reason / Error | Duration |\n|---|---|---|---|\n${failureRows}` : "_No failed or skipped URLs recorded._"}

${errors.length > 0 ? `\n### System Errors Logged\n\n${errors.map((e) => `- **[${e.phase}]**: ${e.message} ${e.code ? `(\`${e.code}\`)` : ""} ${e.url ? `on \`${e.url}\`` : ""}`).join("\n")}` : ""}

---
${comparisonSection}
## Identified Bottlenecks & Accuracy Caveats

1. **Search Engine Upstream Latency**:
   The initial search provider (SearXNG) performs upstream web queries sequentially before candidates are known. Search provider latency represents a significant portion of overall wall-clock time.
2. **DNS & SSRF Pinning**:
   SSRF protection requires asynchronous DNS lookup and IP validation prior to establishing sockets. While essential for security, DNS resolution adds 10-30 ms per unique origin.
3. **Wall-Clock vs. Parallel Sum**:
   Crawl wall-clock time is measured using monotonic \`performance.now()\` from parallel dispatch to completion. Summing individual URL durations would misrepresent parallel execution.
4. **JavaScript Rendering**:
   Client-rendered SPA pages (without server-side rendering) yield initial container text only because the runtime uses lightweight HTTP fetching rather than a headless browser.
`;
}
