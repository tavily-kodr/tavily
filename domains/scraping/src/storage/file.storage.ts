import fs from "node:fs/promises";
import fsSync from "node:fs";
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
  public readonly rootDir: string;

  constructor(baseDir = "./storage") {
    let current = process.cwd();
    let resolvedRoot = current;
    for (let i = 0; i < 4; i++) {
      if (fsSync.existsSync(path.resolve(current, "pnpm-workspace.yaml"))) {
        resolvedRoot = current;
        break;
      }
      const parent = path.resolve(current, "..");
      if (parent === current) break;
      current = parent;
    }
    this.rootDir = path.resolve(resolvedRoot, baseDir);
  }

  /**
   * Securely resolves a crawl folder path, throwing an error if path traversal is detected.
   */
  public getSecureCrawlDir(crawlId: string): string {
    const safeId = sanitizePathComponent(crawlId);
    const resolvedPath = path.resolve(this.rootDir, "crawls", safeId);
    const safeRoot = path.resolve(this.rootDir, "crawls");

    // Path Traversal Check
    if (!resolvedPath.startsWith(safeRoot)) {
      throw new Error(`Directory traversal attempt detected in crawlId: '${crawlId}'`);
    }

    return resolvedPath;
  }

  public getStoragePaths(crawlId: string) {
    const crawlDir = this.getSecureCrawlDir(crawlId);
    return {
      rootDir: this.rootDir,
      crawlDir,
      manifestPath: path.join(crawlDir, "manifest.json"),
      combinedMarkdownPath: path.join(crawlDir, "crawl.md"),
      latestMarkdownPath: path.join(this.rootDir, "latest_crawl.md"),
    };
  }

  public async saveCrawl(crawl: CrawlResponse): Promise<void> {
    const crawlDir = this.getSecureCrawlDir(crawl.crawlId);
    await fs.mkdir(crawlDir, { recursive: true });

    // 1. Write manifest.json with full pages array
    const manifestPath = path.join(crawlDir, "manifest.json");
    const manifestData = {
      crawlId: crawl.crawlId,
      success: crawl.success,
      stats: crawl.stats,
      totalPages: crawl.pages.length,
      createdAt: new Date().toISOString(),
      pages: crawl.pages,
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2), "utf-8");

    // 2. Write single consolidated Markdown containing all scraped & crawled data
    const combinedMd = [
      `# Unified Crawl Data Archive`,
      `- **Crawl ID:** \`${crawl.crawlId}\``,
      `- **Date:** ${new Date().toISOString()}`,
      `- **Total Pages:** ${crawl.pages.length}`,
      `- **Crawled Successfully:** ${crawl.stats.totalCrawled}`,
      `- **Duration:** ${crawl.stats.durationMs}ms`,
      "",
      "---",
      "",
      ...crawl.pages.map((p, idx) => {
        const lines = [
          `## Page ${idx + 1}: ${p.metadata?.title || p.url}`,
          `- **Source URL:** [${p.url}](${p.url})`,
          `- **Status Code:** ${p.statusCode} | **Depth:** ${p.depth}`,
        ];
        if (p.metadata?.description) {
          lines.push(`- **Description:** ${p.metadata.description}`);
        }
        lines.push("", p.markdown || "*(No markdown body extracted)*", "", "---", "");
        return lines.join("\n");
      }),
    ].join("\n");

    const combinedMdPath = path.join(crawlDir, "crawl.md");
    await fs.writeFile(combinedMdPath, combinedMd, "utf-8");

    try {
      await fs.writeFile(path.join(this.rootDir, "latest_crawl.md"), combinedMd, "utf-8");
    } catch {
      // ignore
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
      const manifestPath = path.join(crawlDir, "manifest.json");
      if (fsSync.existsSync(manifestPath)) {
        const manifestRaw = await fs.readFile(manifestPath, "utf-8");
        const parsed = JSON.parse(manifestRaw);
        if (Array.isArray(parsed.pages)) {
          return parsed.pages;
        }
      }

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
