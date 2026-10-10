export interface CrawlRequestInput {
  url?: string | undefined;
  seedUrl?: string | undefined;
  maxPages?: number | undefined;
  max_pages?: number | undefined;
  maxDepth?: number | undefined;
  max_depth?: number | undefined;
  concurrency?: number | undefined;
  sameDomainOnly?: boolean | undefined;
  same_domain_only?: boolean | undefined;
  maxQueueSize?: number | undefined;
  max_queue_size?: number | undefined;
  crawlDelayMs?: number | undefined;
  crawl_delay_ms?: number | undefined;
  timeoutMs?: number | undefined;
  timeout_ms?: number | undefined;
  crawlTimeoutMs?: number | undefined;
  respectRobotsTxt?: boolean | undefined;
  respect_robots_txt?: boolean | undefined;
  userAgent?: string | undefined;
  user_agent?: string | undefined;
}

export interface CrawlPageResponseItem {
  url: string;
  final_url: string;
  depth: number;
  status_code: number;
  title: string;
  description?: string | undefined;
  canonical_url?: string | undefined;
  language?: string | undefined;
  text: string;
  links: string[];
  took_ms: number;
  resolved_ip: string;
}

export interface CrawlFailedResponseItem {
  url: string;
  depth: number;
  error: string;
  code?: string | undefined;
  status_code?: number | undefined;
}

export interface CrawlMetricsResponse {
  total_discovered: number;
  total_visited: number;
  queue_limit_reached: boolean;
  discarded_due_to_queue_limit: number;
  robots_blocked_count: number;
}

export interface CrawlResponseData {
  seed_url: string;
  canonical_seed_url: string;
  pages: CrawlPageResponseItem[];
  failed_pages: CrawlFailedResponseItem[];
  metrics: CrawlMetricsResponse;
  took_ms: number;
}

export interface CrawlSuccessResponse {
  success: true;
  data: CrawlResponseData;
}

export interface CrawlErrorDetail {
  code: string;
  message: string;
}

export interface CrawlErrorResponse {
  success: false;
  error: CrawlErrorDetail;
}

export type CrawlApiResponse = CrawlSuccessResponse | CrawlErrorResponse;
