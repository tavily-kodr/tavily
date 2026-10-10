import { z } from "zod";
import { loadEnv } from "@tavily/config";
import type { SearchConfig } from "./types/search.types.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function ensureDomainEnv() {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    const domainDir = path.dirname(fileURLToPath(import.meta.url));
    const domainEnv = path.resolve(domainDir, "../.env");
    if (fs.existsSync(domainEnv)) {
      process.loadEnvFile(domainEnv);
    }
  } catch {
    // ignore
  }
}

ensureDomainEnv();

const searchEnvSchema = z.object({
  SEARXNG_URL: z.string().default("http://127.0.0.1:8080"),
  SEARCH_TIMEOUT_MS: z.coerce.number().positive().default(5000),
  PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.string().default("development"),
  MAX_RESULTS: z.coerce.number().positive().default(10),
  CRAWL_CANDIDATES: z
    .preprocess((val) => {
      if (typeof val === "string") return val.toLowerCase() !== "false" && val !== "0";
      return val !== undefined ? Boolean(val) : true;
    }, z.boolean())
    .default(true),
  MAX_CRAWL_RESULTS: z.coerce.number().positive().default(5),
  CRAWL_CONCURRENCY: z.coerce.number().positive().default(3),
  CRAWL_TIMEOUT_MS: z.coerce.number().positive().default(4000),
  RESPECT_ROBOTS_TXT: z
    .preprocess((val) => {
      if (typeof val === "string") return val.toLowerCase() === "true" || val === "1";
      return Boolean(val);
    }, z.boolean())
    .default(false),
});

export function getSearchConfig(): SearchConfig {
  const env = loadEnv(searchEnvSchema);
  return {
    searxngUrl: env.SEARXNG_URL.replace(/\/+$/, ""),
    timeoutMs: env.SEARCH_TIMEOUT_MS,
    maxResults: env.MAX_RESULTS,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    crawlCandidates: env.CRAWL_CANDIDATES,
    maxCrawlResults: env.MAX_CRAWL_RESULTS,
    crawlConcurrency: env.CRAWL_CONCURRENCY,
    crawlTimeoutMs: env.CRAWL_TIMEOUT_MS,
    respectRobotsTxt: env.RESPECT_ROBOTS_TXT,
  };
}
