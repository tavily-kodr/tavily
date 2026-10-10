import type { CrawlResponse, PageRecord } from "../types/output.types.js";

export interface CrawlStorage {
  saveCrawl(crawl: CrawlResponse): Promise<void>;
  getCrawl(crawlId: string): Promise<CrawlResponse | null>;
  savePage(crawlId: string, page: PageRecord, pageIndex?: number): Promise<void>;
  getPage(crawlId: string, normalizedUrl: string): Promise<PageRecord | null>;
  listPages(crawlId: string): Promise<PageRecord[]>;
}
