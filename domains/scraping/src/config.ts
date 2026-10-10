import { z } from "zod";
import { loadEnv } from "@tavily/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function ensureDomainEnv(): void {
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

const scrapingEnvSchema = z.object({
  PORT: z.coerce.number().positive().default(3001),
  NODE_ENV: z.string().default("development"),
  MAX_STREAM_BYTES: z.coerce.number().positive().default(10485760), // 10MB
  FETCH_TIMEOUT_MS: z.coerce.number().positive().default(15000), // 15s
  MAX_REDIRECTS: z.coerce.number().positive().default(5),
  GLOBAL_CONCURRENCY: z.coerce.number().positive().default(8),
  PER_DOMAIN_CONCURRENCY: z.coerce.number().positive().default(2),
  STORAGE_DIR: z.string().default("./storage"),
  SEARCH_SERVICE_URL: z.string().default("http://127.0.0.1:3000"),
  ENABLE_PLAYWRIGHT_FALLBACK: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
});

export interface ScrapingConfig {
  port: number;
  nodeEnv: string;
  maxStreamBytes: number;
  fetchTimeoutMs: number;
  maxRedirects: number;
  globalConcurrency: number;
  perDomainConcurrency: number;
  storageDir: string;
  searchServiceUrl: string;
  enablePlaywrightFallback: boolean;
}

export function getScrapingConfig(): ScrapingConfig {
  const env = loadEnv(scrapingEnvSchema);
  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    maxStreamBytes: env.MAX_STREAM_BYTES,
    fetchTimeoutMs: env.FETCH_TIMEOUT_MS,
    maxRedirects: env.MAX_REDIRECTS,
    globalConcurrency: env.GLOBAL_CONCURRENCY,
    perDomainConcurrency: env.PER_DOMAIN_CONCURRENCY,
    storageDir: path.resolve(process.cwd(), env.STORAGE_DIR),
    searchServiceUrl: env.SEARCH_SERVICE_URL.replace(/\/+$/, ""),
    enablePlaywrightFallback: env.ENABLE_PLAYWRIGHT_FALLBACK,
  };
}
