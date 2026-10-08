import { z } from "zod";
import { loadEnv } from "@tavily/config";

// Environment schema for SearXNG connection and retry configuration
const searxngEnvSchema = z.object({
  SEARXNG_BASE_URL: z.string().url().default("http://localhost:8080"),
  SEARXNG_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  SEARXNG_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
});

export type SearXNGEnv = z.infer<typeof searxngEnvSchema>;

// Loads and validates SearXNG environment variables
export function loadSearXNGConfig(): SearXNGEnv {
  return loadEnv(searxngEnvSchema);
}
