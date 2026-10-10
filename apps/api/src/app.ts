import express, { type Express, type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import { ZodError } from "zod";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import { apiRouter } from "./routes/api.routes.js";

export function createApiApp(customRouter = apiRouter): Express {
  const app = express();

  app.use(express.json());

  // Determine repository root and storage path
  let currentDir = process.cwd();
  let workspaceRoot = currentDir;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.resolve(currentDir, "pnpm-workspace.yaml"))) {
      workspaceRoot = currentDir;
      break;
    }
    const parent = path.resolve(currentDir, "..");
    if (parent === currentDir) break;
    currentDir = parent;
  }
  const storageDir = path.resolve(workspaceRoot, "storage");

  // Health and readiness probes
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/ready", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ready" });
  });

  // Serve static files from storage directory (e.g. /storage/latest_crawl.md, /storage/crawls/...)
  app.use("/storage", express.static(storageDir));

  // Direct endpoint to read or download the latest crawl markdown file
  app.get("/latest_crawl.md", (_req: Request, res: Response) => {
    const latestPath = path.join(storageDir, "latest_crawl.md");
    if (fs.existsSync(latestPath)) {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.sendFile(latestPath);
    } else {
      res.status(404).send("# No crawl performed yet\nExecute a crawl to generate latest_crawl.md");
    }
  });

  // Main API Router: /api/... and root /...
  app.use("/api", customRouter);
  app.use("/", customRouter);

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
