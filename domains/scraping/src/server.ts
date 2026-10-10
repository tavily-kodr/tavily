import { logger } from "@tavily/logger";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? process.env.SCRAPING_PORT ?? 3001);

const server = app.listen(port, () => {
  logger.info("Scraping API server started", {
    port,
    nodeEnv: process.env.NODE_ENV ?? "development",
  });
});

export default server;
