import type { CrawlResponse, PageRecord } from "../types/output.types.js";
import type { CrawlStorage } from "./interface.js";

export class InMemoryStorage implements CrawlStorage {
  private readonly crawls = new Map<string, CrawlResponse>();
  private readonly pages = new Map<string, Map<string, PageRecord>>();

  public async saveCrawl(crawl: CrawlResponse): Promise<void> {
    this.crawls.set(crawl.crawlId, crawl);
    let pageMap = this.pages.get(crawl.crawlId);
    if (!pageMap) {
      pageMap = new Map<string, PageRecord>();
      this.pages.set(crawl.crawlId, pageMap);
    }
    for (const page of crawl.pages) {
      pageMap.set(page.normalizedUrl, page);
    }
  }

  public async getCrawl(crawlId: string): Promise<CrawlResponse | null> {
    const found = this.crawls.get(crawlId);
    return found ? structuredClone(found) : null;
  }

  public async savePage(
    crawlId: string,
    page: PageRecord,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _pageIndex?: number,
  ): Promise<void> {
    let pageMap = this.pages.get(crawlId);
    if (!pageMap) {
      pageMap = new Map<string, PageRecord>();
      this.pages.set(crawlId, pageMap);
    }
    pageMap.set(page.normalizedUrl, page);

    const crawl = this.crawls.get(crawlId);
    if (crawl) {
      const idx = crawl.pages.findIndex((p) => p.normalizedUrl === page.normalizedUrl);
      if (idx >= 0) {
        crawl.pages[idx] = page;
      } else {
        crawl.pages.push(page);
      }
    }
  }

  public async getPage(crawlId: string, normalizedUrl: string): Promise<PageRecord | null> {
    const pageMap = this.pages.get(crawlId);
    if (!pageMap) return null;
    const page = pageMap.get(normalizedUrl);
    return page ? structuredClone(page) : null;
  }

  public async listPages(crawlId: string): Promise<PageRecord[]> {
    const pageMap = this.pages.get(crawlId);
    if (!pageMap) return [];
    return Array.from(pageMap.values()).map((p) => structuredClone(p));
  }
}
