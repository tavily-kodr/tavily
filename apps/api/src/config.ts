import { z } from "zod";
import { loadEnv } from "@tavily/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function ensureAppEnv(): void {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    const appDir = path.dirname(fileURLToPath(import.meta.url));
    const appEnv = path.resolve(appDir, "../.env");
    if (fs.existsSync(appEnv)) {
      process.loadEnvFile(appEnv);
    }
  } catch {
    // ignore
  }
}

ensureAppEnv();

const apiEnvSchema = z.object({
  PORT: z.coerce.number().positive().default(4000),
  NODE_ENV: z.string().default("development"),
  DEFAULT_MAX_RESULTS: z.coerce.number().positive().default(5),
});

export interface ApiConfig {
  port: number;
  nodeEnv: string;
  defaultMaxResults: number;
}

export function getApiConfig(): ApiConfig {
  const env = loadEnv(apiEnvSchema);
  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    defaultMaxResults: env.DEFAULT_MAX_RESULTS,
  };
}
