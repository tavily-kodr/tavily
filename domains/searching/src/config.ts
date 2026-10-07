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
});

export function getSearchConfig(): SearchConfig {
  const env = loadEnv(searchEnvSchema);
  return {
    searxngUrl: env.SEARXNG_URL.replace(/\/+$/, ""),
    timeoutMs: env.SEARCH_TIMEOUT_MS,
    maxResults: env.MAX_RESULTS,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
  };
}
