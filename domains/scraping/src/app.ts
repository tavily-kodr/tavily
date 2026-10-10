import fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { ZodError } from "zod";
import { AppError } from "@tavily/errors";
import { logger } from "@tavily/logger";
import { CrawlerEngine } from "./core/engine.js";
import { FileSystemStorage } from "./storage/file.storage.js";
import { getScrapingConfig } from "./config.js";
import {
  ExtractRequestSchema,
  MapRequestSchema,
  CrawlRequestSchema,
} from "./types/schemas.types.js";

export async function buildScrapingApp(customEngine?: CrawlerEngine): Promise<FastifyInstance> {
  const config = getScrapingConfig();
  const engine =
    customEngine ??
    new CrawlerEngine({
      storage: new FileSystemStorage(config.storageDir),
      globalConcurrency: config.globalConcurrency,
      perDomainConcurrency: config.perDomainConcurrency,
    });

  const app = fastify({
    logger: false, // We use @tavily/logger instead of default pino
  });

  // 1. Security & CORS
  await app.register(helmet, {
    contentSecurityPolicy: false, // Required for Swagger UI inline scripts
  });
  await app.register(cors, {
    origin: true,
  });

  // 2. OpenAPI Swagger Specification & UI
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Tavily Crawling & Scraping API",
        description:
          "High-performance, AI-native Crawler, URL Mapper, and Markdown Extractor engine.",
        version: "1.0.0",
      },
      servers: [
        {
          url: `http://localhost:${config.port}`,
          description: "Local development server",
        },
      ],
      tags: [
        { name: "Scraping", description: "High-fidelity HTML to Markdown extraction" },
        { name: "Mapping", description: "URL discovery and site topology mapping" },
        { name: "Crawling", description: "Deep BFS recursive web crawling" },
        { name: "System", description: "Health and operational metrics" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // 3. Health & Ops Routes
  app.get(
    "/health",
    {
      schema: {
        tags: ["System"],
        summary: "Service healthcheck",
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
          },
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  app.get(
    "/ready",
    {
      schema: {
        tags: ["System"],
        summary: "Service readiness probe",
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
          },
        },
      },
    },
    async () => ({ status: "ready" }),
  );

  app.get(
    "/metrics",
    {
      schema: {
        tags: ["System"],
        summary: "Process and engine telemetry",
      },
    },
    async () => ({
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    }),
  );

  // 4. POST /v1/extract
  app.post(
    "/v1/extract",
    {
      schema: {
        tags: ["Scraping"],
        summary: "Batch extract web pages to high-fidelity Markdown",
        body: {
          type: "object",
          properties: {
            urls: { type: "array", items: { type: "string" } },
            query: { type: "string", description: "Search query to automatically resolve URLs" },
            includeImages: { type: "boolean", default: false },
            fallbackToPlaywright: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const validated = ExtractRequestSchema.parse(request.body);
      const result = await engine.extract(validated);
      return reply.status(200).send(result);
    },
  );

  // 5. POST /v1/map
  app.post(
    "/v1/map",
    {
      schema: {
        tags: ["Mapping"],
        summary: "Discover URL paths from a domain via sitemaps and shallow BFS",
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            maxDepth: { type: "number", default: 2 },
            maxBreadth: { type: "number", default: 50 },
            limit: { type: "number", default: 100 },
            selectPaths: { type: "array", items: { type: "string" } },
            excludePaths: { type: "array", items: { type: "string" } },
            allowExternal: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const validated = MapRequestSchema.parse(request.body);
      const result = await engine.map(validated);
      return reply.status(200).send(result);
    },
  );

  // 6. POST /v1/crawl
  app.post(
    "/v1/crawl",
    {
      schema: {
        tags: ["Crawling"],
        summary: "Initiate a full BFS deep crawl with persistence and frontier bounds",
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            limit: { type: "number", default: 50 },
            maxDepth: { type: "number", default: 2 },
            maxBreadth: { type: "number", default: 50 },
            crawlTimeoutMs: { type: "number", default: 60000 },
            selectPaths: { type: "array", items: { type: "string" } },
            excludePaths: { type: "array", items: { type: "string" } },
            selectDomains: { type: "array", items: { type: "string" } },
            excludeDomains: { type: "array", items: { type: "string" } },
            allowExternal: { type: "boolean", default: false },
            ignoreRobots: { type: "boolean", default: false },
            enablePlaywrightFallback: { type: "boolean", default: false },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const validated = CrawlRequestSchema.parse(request.body);
      const result = await engine.crawl(validated);
      return reply.status(200).send(result);
    },
  );

  // 7. Global Error Handler
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          details: error.issues,
        },
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    logger.error("Unhandled API exception", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return reply.status(500).send({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal server error occurred",
      },
    });
  });

  return app;
}
