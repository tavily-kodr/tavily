export interface BenchmarkConfig {
  query?: string;
  maxResults: number;
  crawlConcurrency: number;
  crawlTimeoutMs: number;
  respectRobotsTxt: boolean;
  live: boolean;
  apiUrl?: string;
}

export interface BenchmarkUrlResult {
  url: string;
  finalUrl: string;
  status: "success" | "failed" | "skipped";
  durationMs: number;
  charactersExtracted: number;
  wordsExtracted: number;
  fetchMethod: "HTTP" | "SKIP" | "NONE";
  fallbackUsed: boolean;
  error: string | null;
  statusCode?: number;
}

export interface BenchmarkError {
  url?: string;
  phase: "search" | "validation" | "crawl" | "extraction";
  message: string;
  code?: string;
}

export interface BenchmarkRunSummary {
  query: string;
  searchResultsReturned: number;
  uniqueUrlsSelected: number;
  crawlAttempts: number;
  successfulCrawls: number;
  failedCrawls: number;
  skippedUrls: number;
  pagesWithUsableContent: number;
  pagesWithEmptyContent: number;
  successRatePercent: number;
  totalCharactersExtracted: number;
  totalWordsExtracted: number;
  searchDurationMs: number;
  crawlWallTimeMs: number;
  totalDurationMs: number;
}

export interface BenchmarkPerformance {
  averageCrawlDurationMs: number;
  medianCrawlDurationMs: number;
  fastestCrawlMs: number;
  slowestCrawlMs: number;
  effectiveConcurrency: number;
}

export interface BenchmarkReport {
  schemaVersion: "1.0.0";
  runId: string;
  startedAt: string;
  finishedAt: string;
  environment: {
    nodeVersion: string;
    os: string;
    isLive: boolean;
  };
  configuration: {
    maxResults: number;
    crawlConcurrency: number;
    crawlTimeoutMs: number;
    respectRobotsTxt: boolean;
  };
  summary: BenchmarkRunSummary;
  results: BenchmarkUrlResult[];
  errors: BenchmarkError[];
  performance: BenchmarkPerformance;
  comparison?: {
    baselineRunId: string;
    baselineTotalDurationMs?: number;
    baselineCrawlDurationMs?: number;
    baselineWords?: number;
    baselineSuccessRatePercent?: number;
    totalDurationDeltaMs: number;
    crawlDurationDeltaMs: number;
    wordsDelta: number;
    successRateDeltaPercent: number;
  } | null;
}
