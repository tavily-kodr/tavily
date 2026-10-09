import { logger } from "@tavily/logger";
import { app } from "./app.js";
import { getApiConfig } from "./config.js";

const config = getApiConfig();

const server = app.listen(config.port, () => {
  logger.info("Tavily Unified API Orchestrator started", {
    port: config.port,
    nodeEnv: config.nodeEnv,
    endpoint: `http://localhost:${config.port}/api/search`,
  });
});

export default server;
