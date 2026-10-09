import { loadEnv } from "@tavily/config";
import { logger } from "@tavily/logger";
import { z } from "zod";
import { app } from "./app.js";

const apiEnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
});

const env = loadEnv(apiEnvSchema);

app.listen(env.PORT, () => {
  logger.info(`Search service running at http://localhost:${env.PORT}`);
  logger.info(`Try: http://localhost:${env.PORT}/search?q=hello+world`);
});
