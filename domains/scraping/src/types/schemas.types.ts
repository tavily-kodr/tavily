import { z } from "zod";

export const ExtractRequestSchema = z
  .object({
    urls: z.array(z.string().url("Must be a valid URL")).min(1).max(100).optional(),
    query: z.string().trim().min(1, "Search query must not be empty").optional(),
    includeImages: z.boolean().default(false),
    fallbackToPlaywright: z.boolean().default(false),
  })
  .refine((data) => (data.urls && data.urls.length > 0) || Boolean(data.query), {
    message: "Either 'urls' (min 1 URL) or 'query' must be provided",
    path: ["urls"],
  });

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;
export type ExtractRequestInput = z.input<typeof ExtractRequestSchema>;

export const MapRequestSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  maxDepth: z.number().int().min(1).max(10).default(2),
  maxBreadth: z.number().int().min(1).max(500).default(50),
  limit: z.number().int().min(1).max(1000).default(100),
  selectPaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  allowExternal: z.boolean().default(false),
});

export type MapRequest = z.infer<typeof MapRequestSchema>;
export type MapRequestInput = z.input<typeof MapRequestSchema>;

export const CrawlRequestSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  limit: z.number().int().min(1).max(1000).default(50),
  maxDepth: z.number().int().min(1).max(10).default(2),
  maxBreadth: z.number().int().min(1).max(500).default(50),
  crawlTimeoutMs: z.number().int().positive().default(60000),
  selectPaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
  selectDomains: z.array(z.string()).default([]),
  excludeDomains: z.array(z.string()).default([]),
  allowExternal: z.boolean().default(false),
  ignoreRobots: z.boolean().default(false),
  enablePlaywrightFallback: z.boolean().default(false),
});

export type CrawlRequest = z.infer<typeof CrawlRequestSchema>;
export type CrawlRequestInput = z.input<typeof CrawlRequestSchema>;
