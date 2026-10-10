import {
  runFixtureBenchmark,
  runLiveBenchmark,
} from "../domains/searching/test/benchmark/runner.js";

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes("--live");
  const queryIdx = args.indexOf("--query");
  const query = queryIdx !== -1 && args[queryIdx + 1] ? args[queryIdx + 1] : undefined;

  const maxResultsIdx = args.indexOf("--max-results");
  const maxResults =
    maxResultsIdx !== -1 && args[maxResultsIdx + 1] ? Number(args[maxResultsIdx + 1]) : 5;

  const concurrencyIdx = args.indexOf("--concurrency");
  const crawlConcurrency =
    concurrencyIdx !== -1 && args[concurrencyIdx + 1] ? Number(args[concurrencyIdx + 1]) : 3;

  console.log(`\n======================================================`);
  console.log(`  Tavily Search & Crawl Benchmark Runner`);
  console.log(`  Mode: ${isLive ? "Live API (http://localhost:3000)" : "Deterministic Fixtures"}`);
  console.log(
    `  Query: ${query ?? (isLive ? "technology innovations" : "deterministic-fixture-test")}`,
  );
  console.log(`  Max Results: ${maxResults} | Concurrency: ${crawlConcurrency}`);
  console.log(`======================================================\n`);

  try {
    let result;
    if (isLive) {
      result = await runLiveBenchmark({ query, maxResults, crawlConcurrency });
    } else {
      result = await runFixtureBenchmark({ query, maxResults, crawlConcurrency });
    }

    const { report, jsonPath, mdPath } = result;

    console.log(`\n Benchmark Completed Successfully!`);
    console.log(`Run ID:                 ${report.runId}`);
    console.log(`Total Duration:         ${report.summary.totalDurationMs.toFixed(1)} ms`);
    console.log(`Search Duration:        ${report.summary.searchDurationMs.toFixed(1)} ms`);
    console.log(`Crawl Wall Time:        ${report.summary.crawlWallTimeMs.toFixed(1)} ms`);
    console.log(`Crawl Attempts:         ${report.summary.crawlAttempts}`);
    console.log(`Successful Crawls:      ${report.summary.successfulCrawls}`);
    console.log(`Pages with Usable Text: ${report.summary.pagesWithUsableContent}`);
    console.log(`Total Words Extracted:  ${report.summary.totalWordsExtracted.toLocaleString()}`);
    console.log(`Success Rate:           ${report.summary.successRatePercent.toFixed(1)}%`);
    console.log(`\n Reports Generated:`);
    console.log(`  JSON:     ${jsonPath}`);
    console.log(`  Markdown: ${mdPath}\n`);
  } catch (err: unknown) {
    console.error(`\n❌ Benchmark failed:`, err);
    process.exit(1);
  }
}

main();
