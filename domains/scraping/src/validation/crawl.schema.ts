import { z } from "zod";
import { AppError } from "@tavily/errors";
import type { CrawlOptions } from "../types/crawl.types.js";

export const MAX_ALLOWED_PAGES = 50;
export const MAX_ALLOWED_DEPTH = 5;
export const MAX_ALLOWED_CONCURRENCY = 10;
export const MAX_ALLOWED_QUEUE_SIZE = 1000;
export const MAX_ALLOWED_DELAY_MS = 10000;
export const MAX_ALLOWED_TIMEOUT_MS = 60000;
export const MIN_ALLOWED_TIMEOUT_MS = 100;
export const DEFAULT_TIMEOUT_MS = 30000;

const rawCrawlRequestSchema = z
  .object({
    url: z.string().optional(),
    seedUrl: z.string().optional(),
    seed_url: z.string().optional(),

    maxPages: z.number().int().min(1).max(MAX_ALLOWED_PAGES).optional(),
    max_pages: z.number().int().min(1).max(MAX_ALLOWED_PAGES).optional(),

    maxDepth: z.number().int().min(0).max(MAX_ALLOWED_DEPTH).optional(),
    max_depth: z.number().int().min(0).max(MAX_ALLOWED_DEPTH).optional(),

    concurrency: z.number().int().min(1).max(MAX_ALLOWED_CONCURRENCY).optional(),

    sameDomainOnly: z.boolean().optional(),
    same_domain_only: z.boolean().optional(),

    maxQueueSize: z.number().int().min(1).max(MAX_ALLOWED_QUEUE_SIZE).optional(),
    max_queue_size: z.number().int().min(1).max(MAX_ALLOWED_QUEUE_SIZE).optional(),

    crawlDelayMs: z.number().min(0).max(MAX_ALLOWED_DELAY_MS).optional(),
    crawl_delay_ms: z.number().min(0).max(MAX_ALLOWED_DELAY_MS).optional(),

    timeoutMs: z.number().min(MIN_ALLOWED_TIMEOUT_MS).max(MAX_ALLOWED_TIMEOUT_MS).optional(),
    timeout_ms: z.number().min(MIN_ALLOWED_TIMEOUT_MS).max(MAX_ALLOWED_TIMEOUT_MS).optional(),
    crawlTimeoutMs: z.number().min(MIN_ALLOWED_TIMEOUT_MS).max(MAX_ALLOWED_TIMEOUT_MS).optional(),

    respectRobotsTxt: z.boolean().optional(),
    respect_robots_txt: z.boolean().optional(),

    userAgent: z.string().max(200).optional(),
    user_agent: z.string().max(200).optional(),

    // Explicitly disallow any attempt by client to disable SSRF protection
    allowPrivateNetworks: z.never().optional(),
    allow_private_networks: z.never().optional(),
  })
  .strict();

export interface ValidatedCrawlPayload {
  seedUrl: string;
  options: CrawlOptions;
}

/**
 * Validates, bounds, and normalizes raw API request body into safe CrawlOptions.
 * Throws AppError with 400 status code on invalid options or dangerous inputs.
 */
export function validateCrawlRequest(body: unknown): ValidatedCrawlPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Request body must be a valid JSON object", {
      code: "INVALID_REQUEST",
      statusCode: 400,
    });
  }

  // Explicit security guard: client must never disable SSRF protection
  const rawObj = body as Record<string, unknown>;
  if (rawObj.allowPrivateNetworks === true || rawObj.allow_private_networks === true) {
    throw new AppError("Disabling SSRF protection is strictly prohibited", {
      code: "FORBIDDEN_OPTION",
      statusCode: 400,
    });
  }

  const parseResult = rawCrawlRequestSchema.safeParse(body);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const fieldPath = firstIssue?.path.join(".") ?? "unknown";
    const issueMessage = firstIssue?.message ?? "Invalid input";

    throw new AppError(`Invalid request field '${fieldPath}': ${issueMessage}`, {
      code: "INVALID_OPTIONS",
      statusCode: 400,
      details: parseResult.error.issues,
    });
  }

  const data = parseResult.data;
  const candidateUrl = data.url ?? data.seedUrl ?? data.seed_url;

  if (typeof candidateUrl !== "string" || !candidateUrl.trim()) {
    throw new AppError("A seed 'url' is required", {
      code: "INVALID_URL",
      statusCode: 400,
    });
  }

  const seedUrl = candidateUrl.trim();

  // Basic syntax check before delegating to crawler
  try {
    const parsed = new URL(seedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError(
        `Unsupported URL protocol '${parsed.protocol}'. Only http: and https: are allowed`,
        {
          code: "INVALID_URL",
          statusCode: 400,
        },
      );
    }
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    throw new AppError(`Malformed URL '${seedUrl}'`, {
      code: "INVALID_URL",
      statusCode: 400,
    });
  }

  const options: CrawlOptions = {
    maxPages: data.maxPages ?? data.max_pages ?? 10,
    maxDepth: data.maxDepth ?? data.max_depth ?? 2,
    concurrency: data.concurrency ?? 2,
    sameDomainOnly: data.sameDomainOnly ?? data.same_domain_only ?? true,
    maxQueueSize: data.maxQueueSize ?? data.max_queue_size ?? 1000,
    crawlDelayMs: data.crawlDelayMs ?? data.crawl_delay_ms ?? 0,
    crawlTimeoutMs: data.crawlTimeoutMs ?? data.timeoutMs ?? data.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    respectRobotsTxt: data.respectRobotsTxt ?? data.respect_robots_txt ?? false,
    userAgent: data.userAgent ?? data.user_agent,
    // SSRF protections are ALWAYS strictly enforced at API boundary
    allowPrivateNetworks: false,
  };

  return { seedUrl, options };
}
