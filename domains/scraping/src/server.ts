import { logger } from "@tavily/logger";
import { buildScrapingApp } from "./app.js";
import { getScrapingConfig } from "./config.js";

const config = getScrapingConfig();

async function startServer(): Promise<void> {
  try {
    const app = await buildScrapingApp();

    await app.listen({
      port: config.port,
      host: "0.0.0.0",
    });

    logger.info("Scraping & Crawler API server started", {
      port: config.port,
      nodeEnv: config.nodeEnv,
      docsUrl: `http://localhost:${config.port}/docs`,
      storageDir: config.storageDir,
      concurrency: {
        global: config.globalConcurrency,
        perDomain: config.perDomainConcurrency,
      },
    });
  } catch (err: unknown) {
    logger.error("Failed to start Scraping API server", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

startServer();
