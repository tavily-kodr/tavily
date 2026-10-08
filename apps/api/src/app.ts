import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { gzip } from "node:zlib";
import { loadEnv } from "@tavily/config";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import {
  configureSearchCache,
  configureSearxngClient,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_EAGER_PAGES,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_PAGING_BUDGET_MS,
  MAX_EAGER_PAGES,
  MAX_PAGES,
  MAX_POOL_SIZE,
  webSearch,
  type SearchResponse,
} from "@tavily/searching";
import { z } from "zod";

export const app: Express = express();

// Smaller bodies are not worth the CPU.
const GZIP_MIN_BYTES = 1024;

/** Gzips JSON responses for clients that accept it (no extra dependency). */
function gzipJson(req: Request, res: Response, next: NextFunction): void {
  const sendJson = res.json.bind(res);
  res.json = (body: unknown) => {
    res.vary("Accept-Encoding");
    const raw = Buffer.from(JSON.stringify(body));
    if (raw.length < GZIP_MIN_BYTES || !/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      return sendJson(body);
    }
    gzip(raw, (err, compressed) => {
      if (err) {
        sendJson(body);
        return;
      }
      res.set("Content-Encoding", "gzip").type("application/json").send(compressed);
    });
    return res;
  };
  next();
}

app.use(cors());
app.use(gzipJson);
app.use(express.json());

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;

// Accepts "a.com,b.org" or repeated params (?include_domains=a.com&include_domains=b.org).
const domainListSchema = (param: string) =>
  z.preprocess(
    (val) => {
      if (val === undefined || val === "") return [];
      const parts = Array.isArray(val) ? val : [val];
      return parts.flatMap((p) =>
        typeof p === "string"
          ? p
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean)
          : [p],
      );
    },
    z
      .array(z.string().regex(DOMAIN_PATTERN, `Query param '${param}' must list valid domains`))
      .max(50, `Query param '${param}' must not list more than 50 domains`),
  );

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, "Missing required query param 'q'"),
  max_results: z.preprocess(
    (val) => {
      if (val === undefined || val === null || val === "") return MAX_POOL_SIZE;
      const parsed = Number(val);
      return isNaN(parsed) ? val : parsed;
    },
    z
      .number({ message: "Query param 'max_results' must be an integer between 1 and 20" })
      .int("Query param 'max_results' must be an integer between 1 and 20")
      .min(1, "Query param 'max_results' must be an integer between 1 and 20")
      .max(20, "Query param 'max_results' must be an integer between 1 and 20"),
  ),
  include_domains: domainListSchema("include_domains"),
  exclude_domains: domainListSchema("exclude_domains"),
  time_range: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .enum(["day", "week", "month", "year"], {
        message: "Query param 'time_range' must be one of day, week, month, year",
      })
      .optional(),
  ),
  topic: z.preprocess(
    (val) => (val === undefined || val === "" ? "general" : val),
    z.enum(["general", "news"], { message: "Query param 'topic' must be general or news" }),
  ),
  language: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z
      .string()
      .regex(
        /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/,
        "Query param 'language' must look like 'en' or 'en-US'",
      )
      .default("en-US"),
  ),
});

const apiEnvSchema = z.object({
  SEARXNG_URL: z.string().url().default("http://localhost:8080"),
  // Comma-separated engines enabled in SearXNG; used to detect a total outage.
  SEARXNG_ENGINES: z.string().default("bing,brave,mojeek,wikipedia,yahoo"),
  SEARCH_CACHE_TTL_MS: z.coerce.number().int().positive().default(DEFAULT_CACHE_TTL_MS),
  // Bounds memory: each entry holds at most 20 ranked results.
  SEARCH_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(DEFAULT_CACHE_MAX_ENTRIES),
  // SearXNG requests in flight at once; match SearXNG workers x threads.
  SEARXNG_MAX_CONCURRENCY: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MAX_CONCURRENT_REQUESTS),
  // Most SearXNG pages one search may fetch; extra pages only when needed.
  SEARXNG_MAX_PAGES: z.coerce.number().int().min(1).max(MAX_PAGES).default(MAX_PAGES),
  // Pages fetched together with page 1 when max_results needs more than one
  // page; 0 fetches them one round trip at a time after page 1.
  SEARXNG_EAGER_PAGES: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_EAGER_PAGES)
    .default(DEFAULT_EAGER_PAGES),
  // Optional pages start only if they can finish within this many ms of the
  // search start; sparse queries (domain filters) return what they have then.
  SEARXNG_PAGING_BUDGET_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_PAGING_BUDGET_MS),
});

const env = loadEnv(apiEnvSchema);
configureSearchCache({ ttlMs: env.SEARCH_CACHE_TTL_MS, maxEntries: env.SEARCH_CACHE_MAX_ENTRIES });
configureSearxngClient({ maxConcurrentRequests: env.SEARXNG_MAX_CONCURRENCY });
const searchSettings = {
  searxngUrl: env.SEARXNG_URL,
  maxPages: env.SEARXNG_MAX_PAGES,
  eagerPages: env.SEARXNG_EAGER_PAGES,
  pagingBudgetMs: env.SEARXNG_PAGING_BUDGET_MS,
  expectedEngines: env.SEARXNG_ENGINES.split(",")
    .map((e) => e.trim())
    .filter(Boolean),
};

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/search", async (req: Request, res: Response) => {
  const parsed = searchQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const errorMessage =
      firstIssue?.path.includes("q") &&
      (firstIssue.code === "invalid_type" || firstIssue.message.includes("q"))
        ? "Missing required query param 'q'"
        : firstIssue?.message || "Invalid query parameters";
    return res.status(400).json({ error: errorMessage });
  }

  const {
    q: query,
    max_results: maxResults,
    include_domains: includeDomains,
    exclude_domains: excludeDomains,
    time_range: timeRange,
    topic,
    language,
  } = parsed.data;
  const startedAt = Date.now();

  try {
    const { results, cached, partial, failedEngines, failedPages, filtered, enginesUsed } =
      await webSearch(query, maxResults, {
        ...searchSettings,
        language,
        includeDomains,
        excludeDomains,
        timeRange,
        topic,
      });
    const elapsedMs = Date.now() - startedAt;
    const payload: SearchResponse = {
      query,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.snippet,
        score: r.score,
        ...(r.lowConfidence ? { lowConfidence: true } : {}),
      })),
      response_time: elapsedMs / 1000,
      partial,
      failedEngines,
      failedPages,
      filtered,
      enginesUsed,
      cached,
    };
    logger.info("[search] completed", {
      queryLength: query.length,
      resultCount: results.length,
      elapsedMs,
      cached,
    });
    return res.json(payload);
  } catch (err) {
    if (err instanceof AppError) {
      logger.error("Search failed with AppError", {
        message: err.message,
        code: err.code,
        statusCode: err.statusCode,
      });

      const isInternal = err.statusCode >= 500;
      const isProd = process.env["NODE_ENV"] === "production";

      return res.status(err.statusCode).json({
        error: isProd && isInternal ? "Search service temporarily unavailable." : err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error("Search failed with unexpected error", { error: message });

    return res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
});
