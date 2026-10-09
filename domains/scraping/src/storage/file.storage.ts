import fs from "node:fs/promises";
import path from "node:path";
import type { CrawlResponse, PageRecord } from "../types/output.types.js";
import type { CrawlStorage } from "./interface.js";

/**
 * Sanitizes an identifier to prevent directory traversal and filesystem attacks.
 */
export function sanitizePathComponent(name: string): string {
  // Replace illegal filename characters with underscores
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return clean.slice(0, 100) || "unnamed";
}

export function buildFrontmatter(page: PageRecord): string {
  const lines = [
    "---",
    `url: ${JSON.stringify(page.url)}`,
    `normalizedUrl: ${JSON.stringify(page.normalizedUrl)}`,
    `title: ${JSON.stringify(page.metadata.title)}`,
    `depth: ${page.depth}`,
    `timestamp: ${JSON.stringify(page.timestamp)}`,
    `contentHash: ${JSON.stringify(page.metadata.contentHash)}`,
    `byteSize: ${page.metadata.byteSize}`,
    `isSpa: ${page.metadata.isSpa}`,
    `usedPlaywright: ${page.metadata.usedPlaywright}`,
  ];

  if (page.metadata.canonicalUrl) {
    lines.push(`canonicalUrl: ${JSON.stringify(page.metadata.canonicalUrl)}`);
  }
  if (page.metadata.language) {
    lines.push(`language: ${JSON.stringify(page.metadata.language)}`);
  }

  lines.push("---", "", page.markdown);
  return lines.join("\n");
}

export class FileSystemStorage implements CrawlStorage {
  private readonly rootDir: string;

  constructor(baseDir = "./storage") {
    this.rootDir = path.resolve(process.cwd(), baseDir);
  }

  /**
   * Securely resolves a crawl folder path, throwing an error if path traversal is detected.
   */
  private getSecureCrawlDir(crawlId: string): string {
    const safeId = sanitizePathComponent(crawlId);
    const resolvedPath = path.resolve(this.rootDir, "crawls", safeId);
    const safeRoot = path.resolve(this.rootDir, "crawls");

    // Path Traversal Check
    if (!resolvedPath.startsWith(safeRoot)) {
      throw new Error(`Directory traversal attempt detected in crawlId: '${crawlId}'`);
    }

    return resolvedPath;
  }

  public async saveCrawl(crawl: CrawlResponse): Promise<void> {
    const crawlDir = this.getSecureCrawlDir(crawl.crawlId);
    await fs.mkdir(crawlDir, { recursive: true });

    // 1. Write manifest.json
    const manifestPath = path.join(crawlDir, "manifest.json");
    const manifestData = {
      crawlId: crawl.crawlId,
      success: crawl.success,
      stats: crawl.stats,
      totalPages: crawl.pages.length,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2), "utf-8");

    // 2. Write individual page files (page-###.json and page-###.md)
    for (let i = 0; i < crawl.pages.length; i++) {
      const page = crawl.pages[i];
      if (page) {
        await this.savePage(crawl.crawlId, page, i + 1);
      }
    }
  }

  public async getCrawl(crawlId: string): Promise<CrawlResponse | null> {
    const crawlDir = this.getSecureCrawlDir(crawlId);
    const manifestPath = path.join(crawlDir, "manifest.json");

    try {
      const manifestRaw = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestRaw);
      const pages = await this.listPages(crawlId);

      return {
        success: manifest.success,
        crawlId: manifest.crawlId,
        stats: manifest.stats,
        pages,
      };
    } catch {
      return null;
    }
  }

  public async savePage(crawlId: string, page: PageRecord, pageIndex?: number): Promise<void> {
    const crawlDir = this.getSecureCrawlDir(crawlId);
    await fs.mkdir(crawlDir, { recursive: true });

    const prefix =
      pageIndex !== undefined
        ? `page-${String(pageIndex).padStart(4, "0")}`
        : `page-${sanitizePathComponent(page.normalizedUrl)}`;

    // Write full PageRecord JSON
    const jsonPath = path.join(crawlDir, `${prefix}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(page, null, 2), "utf-8");

    // Write Markdown with YAML Frontmatter
    const mdPath = path.join(crawlDir, `${prefix}.md`);
    const mdContent = buildFrontmatter(page);
    await fs.writeFile(mdPath, mdContent, "utf-8");
  }

  public async getPage(crawlId: string, normalizedUrl: string): Promise<PageRecord | null> {
    const pages = await this.listPages(crawlId);
    return pages.find((p) => p.normalizedUrl === normalizedUrl) ?? null;
  }

  public async listPages(crawlId: string): Promise<PageRecord[]> {
    const crawlDir = this.getSecureCrawlDir(crawlId);
    try {
      const files = await fs.readdir(crawlDir);
      const jsonFiles = files.filter((f) => f.startsWith("page-") && f.endsWith(".json")).sort();

      const pages: PageRecord[] = [];
      for (const file of jsonFiles) {
        const filePath = path.join(crawlDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        pages.push(JSON.parse(content));
      }
      return pages;
    } catch {
      return [];
    }
  }
}
