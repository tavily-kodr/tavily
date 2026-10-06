import { z } from "zod";
import { loadEnv } from "@tavily/config";
import type { SearchConfig } from "./types/search.types.js";

const searchEnvSchema = z.object({
  SEARXNG_URL: z.string().default("http://127.0.0.1:8080"),
  SEARCH_TIMEOUT_MS: z.coerce.number().positive().default(5000),
  PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.string().default("development"),
});

export function getSearchConfig(): SearchConfig {
  const env = loadEnv(searchEnvSchema);
  return {
    searxngUrl: env.SEARXNG_URL.replace(/\/+$/, ""),
    timeoutMs: env.SEARCH_TIMEOUT_MS,
    maxResults: 10,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
  };
}
