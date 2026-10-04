export { UniversalScraper, scrape, type UniversalScraperConfig } from './core/scraper.js';
export type {
  ScrapeMode,
  PaginationMode,
  ExtractionRule,
  HtmlFieldRule,
  PaginationConfig,
  ScrapeTarget,
  ScrapeOptions,
  PageDocument,
  PageEvent,
  ScrapeItem,
  ScrapeFailure,
  ScrapeStats,
  ScrapeResult,
  Renderer,
  RenderedPage,
} from './core/types.js';
export {
  HttpClient,
  HttpError,
  NetworkError,
  RequestTimeoutError,
  ResponseParseError,
  ResponseTooLargeError,
  redactUrl,
  type HttpClientOptions,
  type HedgeOptions,
  type PerHostOptions,
  type RevalidateOptions,
  type RequestEvent,
} from './transport/http.js';
export { detectMode } from './detection/content-type.js';
export { parseJson, getJsonPath } from './parsers/json.js';
export { extractHtml, extractNextLink, loadHtml, type HtmlParser } from './parsers/html.js';
export { parsePage, extractFromPage, extractItems, type ParsedPage, type ParseOptions } from './extraction/extract.js';
export { getInitialPageUrl, getNextPageInfo, type NextPageInfo } from './pagination/pagination.js';
export {
  writeJsonOutput,
  assertOutputWritable,
  OutputWriteError,
  type WriteJsonOptions,
  type WriteJsonResult,
  type OutputErrorReason,
} from './output/write-json.js';
