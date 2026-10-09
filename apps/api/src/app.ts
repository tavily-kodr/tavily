import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import { apiRouter } from "./routes/api.routes.js";

export function createApiApp(customRouter = apiRouter): Express {
  const app = express();

  app.use(express.json());

  // Health and readiness probes
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/ready", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ready" });
  });

  // Main API Router: /api/search
  app.use("/api", customRouter);

  // Catch-all 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Endpoint not found",
      },
    });
  });

  // Global error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          details: err.issues,
        },
      });
      return;
    }

    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      });
      return;
    }

    logger.error("Unhandled API exception", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : "An unexpected error occurred",
      },
    });
  });

  return app;
}

export const app: Express = createApiApp();
export default app;
