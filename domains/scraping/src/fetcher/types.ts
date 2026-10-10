export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowLocalNetwork?: boolean;
  headers?: Record<string, string>;
  maxRetries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export interface FetchResponse {
  url: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  byteLength: number;
  contentType: string;
  tookMs: number;
}
