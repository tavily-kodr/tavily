import { logger } from "@tavily/logger";
import { app } from "./app.js";
import { getSearchConfig } from "./config.js";

const config = getSearchConfig();

const server = app.listen(config.port, () => {
  logger.info("Search API server started", {
    port: config.port,
    nodeEnv: config.nodeEnv,
    searxngUrl: config.searxngUrl,
    timeoutMs: config.timeoutMs,
  });
});

export default server;
