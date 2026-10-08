export interface AppConfig {
  nodeEnv: string;
  port: number;
  tavilyApiKey?: string;
  braveApiKey?: string;
  searxngUrl?: string;
  openaiApiKey?: string;
  openaiApiBase?: string;
  openaiModel?: string;
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  maxResultsLimit: number;
}

export function loadConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV || "development",
    port: parseInt(process.env.PORT || "3000", 10),
    tavilyApiKey: process.env.TAVILY_API_KEY?.trim(),
    braveApiKey: process.env.BRAVE_API_KEY?.trim(),
    searxngUrl: process.env.SEARXNG_URL?.trim(),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim(),
    openaiApiBase: process.env.OPENAI_API_BASE?.trim() || "https://api.openai.com/v1",
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    cacheEnabled: process.env.CACHE_ENABLED !== "false",
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || "600", 10),
    maxResultsLimit: parseInt(process.env.MAX_RESULTS_LIMIT || "20", 10),
  };
}

export const config = loadConfig();
