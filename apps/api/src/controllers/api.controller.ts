import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { OrchestratorService } from "../services/orchestrator.service.js";

const searchRequestSchema = z.object({
  query: z.string().trim().min(1, "Query is required"),
  max_results: z.coerce.number().int().min(1).max(100).default(5),
  include_images: z.boolean().default(false),
  fallback_to_playwright: z.boolean().default(false),
});

const crawlRequestSchema = z
  .object({
    url: z.string().optional(),
    urls: z.array(z.string()).optional(),
    query: z.string().trim().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(5),
    max_depth: z.coerce.number().int().min(1).max(50).default(5),
    multi_domain: z.boolean().default(true),
    allow_external: z.boolean().default(false),
    search_limit: z.coerce.number().int().min(1).max(500).optional(),
    seed_limit: z.coerce.number().int().min(1).max(500).optional(),
    fallback_to_playwright: z.boolean().default(false),
  })
  .refine((data) => Boolean(data.url || (data.urls && data.urls.length > 0) || data.query), {
    message: "Either 'url', 'urls', or 'query' must be provided",
    path: ["url"],
  });

export class ApiController {
  constructor(private readonly orchestrator = new OrchestratorService()) {}

  /**
   * Universal endpoint handler supporting query patterns like:
   * http://localhost:4000/?q=typescript&crawl=true&max_url=15&max_depth=10
   */
  public handleUniversal = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const q =
        req.query["q"] ??
        req.query["query"] ??
        req.query["url"] ??
        req.body?.q ??
        req.body?.query ??
        req.body?.url;

      if (!q) {
        if (req.query["format"] === "html") {
          res.setHeader("Content-Type", "text/html");
          res.status(200).send(renderHomeHtml());
          return;
        }

        res.status(200).json({
          status: "online",
          message: "Tavily Unified Search, Crawler & Benchmark API",
          examples: {
            crawl: "/?q=https://example.com&crawl=true&max_url=15&max_depth=10",
            search: "/?q=typescript&max_url=5",
            benchmark: "/benchmark?url=https://example.com",
            benchmarkCustom: "/benchmark?url=https://example.com&combinations=10:5,15:10,15:20",
          },
        });
        return;
      }

      const isCrawl =
        req.query["crawl"] === "true" ||
        req.query["crawl"] === "1" ||
        req.body?.crawl === true ||
        Boolean(req.query["url"]);

      if (isCrawl) {
        await this.handleCrawl(req, res, next);
      } else {
        await this.handleSearch(req, res, next);
      }
    } catch (err) {
      next(err);
    }
  };

  public handleSearch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawPayload = {
        query: req.body?.query ?? req.query["query"] ?? req.query["q"] ?? req.params["query"],
        max_results:
          req.body?.max_results ??
          req.body?.max_url ??
          req.body?.max_urls ??
          req.body?.limit ??
          req.query["max_results"] ??
          req.query["max_url"] ??
          req.query["max_urls"] ??
          req.query["limit"] ??
          5,
        include_images: req.body?.include_images ?? req.query["include_images"] === "true",
        fallback_to_playwright:
          req.body?.fallback_to_playwright ?? req.query["fallback_to_playwright"] === "true",
      };

      const parsed = searchRequestSchema.parse(rawPayload);

      const data = await this.orchestrator.searchAndScrape({
        query: parsed.query,
        maxResults: parsed.max_results,
        includeImages: parsed.include_images,
        fallbackToPlaywright: parsed.fallback_to_playwright,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  };

  public handleCrawl = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const urlParam = req.body?.url ?? req.query["url"];
      let urls: string[] | undefined;
      const rawUrls = req.body?.urls ?? req.query["urls"];
      if (Array.isArray(rawUrls)) {
        urls = rawUrls.map(String);
      } else if (typeof rawUrls === "string" && rawUrls.includes(",")) {
        urls = rawUrls
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (typeof urlParam === "string" && urlParam.includes(",")) {
        urls = urlParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const rawPayload = {
        url: typeof urlParam === "string" && !urlParam.includes(",") ? urlParam : undefined,
        urls,
        query: req.body?.query ?? req.query["query"] ?? req.query["q"],
        limit:
          req.body?.limit ??
          req.body?.max_url ??
          req.body?.max_urls ??
          req.body?.max_results ??
          req.query["limit"] ??
          req.query["max_url"] ??
          req.query["max_urls"] ??
          req.query["max_results"] ??
          5,
        max_depth:
          req.body?.max_depth ??
          req.body?.depth ??
          req.query["max_depth"] ??
          req.query["depth"] ??
          5,
        search_limit:
          req.body?.search_limit ??
          req.body?.search_urls ??
          req.query["search_limit"] ??
          req.query["search_urls"],
        seed_limit:
          req.body?.seed_limit ??
          req.body?.max_seeds ??
          req.query["seed_limit"] ??
          req.query["max_seeds"],
        multi_domain:
          req.body?.multi_domain !== undefined
            ? req.body.multi_domain === true || req.body.multi_domain === "true"
            : req.query["multi_domain"] !== undefined
              ? req.query["multi_domain"] === "true" || req.query["multi_domain"] === "1"
              : true,
        allow_external:
          req.body?.allow_external !== undefined
            ? req.body.allow_external === true || req.body.allow_external === "true"
            : req.query["allow_external"] !== undefined
              ? req.query["allow_external"] === "true" || req.query["allow_external"] === "1"
              : false,
        fallback_to_playwright:
          req.body?.fallback_to_playwright ?? req.query["fallback_to_playwright"] === "true",
      };

      const parsed = crawlRequestSchema.parse(rawPayload);

      const data = await this.orchestrator.searchAndCrawl({
        url: parsed.url,
        urls: parsed.urls,
        query: parsed.query,
        limit: parsed.limit,
        maxDepth: parsed.max_depth,
        searchLimit: parsed.search_limit,
        seedLimit: parsed.seed_limit,
        multiDomain: parsed.multi_domain,
        allowExternal: parsed.allow_external || parsed.multi_domain,
        enablePlaywrightFallback: parsed.fallback_to_playwright,
      });

      if (req.query["format"] === "html") {
        res.setHeader("Content-Type", "text/html");
        res.status(200).send(renderCrawlHtml(data));
        return;
      }

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  };

  public handleBenchmark = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const urlParam =
        (req.query["url"] as string | undefined) ?? (req.body?.url as string | undefined);

      let urlsParam: string[] | undefined;
      const rawUrls = req.query["urls"] ?? req.body?.urls;
      if (Array.isArray(rawUrls)) {
        urlsParam = rawUrls.map(String);
      } else if (typeof rawUrls === "string" && rawUrls.includes(",")) {
        urlsParam = rawUrls
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (typeof urlParam === "string" && urlParam.includes(",")) {
        urlsParam = urlParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const queryParam =
        (req.query["q"] as string | undefined) ??
        (req.query["query"] as string | undefined) ??
        (req.body?.query as string | undefined) ??
        (req.body?.q as string | undefined);

      const searchLimit = parseInt(
        String(
          req.query["search_limit"] ??
            req.query["search_urls"] ??
            req.query["max_results"] ??
            req.body?.search_limit ??
            "",
        ),
        10,
      );
      const seedLimit = parseInt(
        String(req.query["seed_limit"] ?? req.query["max_seeds"] ?? req.body?.seed_limit ?? ""),
        10,
      );

      const multiDomainParam =
        req.body?.multi_domain !== undefined
          ? req.body.multi_domain === true || req.body.multi_domain === "true"
          : req.query["multi_domain"] !== undefined
            ? req.query["multi_domain"] === "true" || req.query["multi_domain"] === "1"
            : true;

      const allowExternalParam =
        req.body?.allow_external !== undefined
          ? req.body.allow_external === true || req.body.allow_external === "true"
          : req.query["allow_external"] !== undefined
            ? req.query["allow_external"] === "true" || req.query["allow_external"] === "1"
            : multiDomainParam;

      let combinations: Array<{ maxUrl: number; maxDepth: number }> | undefined;

      // 1. Check custom combinations query param e.g. "10:5,15:10,15:20"
      const combosQuery =
        (req.query["combinations"] as string | undefined) ?? req.body?.combinations;
      if (typeof combosQuery === "string" && combosQuery.trim()) {
        combinations = combosQuery
          .split(",")
          .map((pair) => {
            const [u, d] = pair.split(":").map((v) => parseInt(v.trim(), 10));
            if (u && d && !isNaN(u) && !isNaN(d)) {
              return { maxUrl: u, maxDepth: d };
            }
            return null;
          })
          .filter((c): c is { maxUrl: number; maxDepth: number } => c !== null);
      }

      // 2. Check direct individual query param e.g. ?max_url=5&max_depth=5
      const directMaxUrl = parseInt(
        String(
          req.query["max_url"] ??
            req.query["max_urls"] ??
            req.query["limit"] ??
            req.body?.max_url ??
            "",
        ),
        10,
      );
      const directMaxDepth = parseInt(
        String(req.query["max_depth"] ?? req.query["depth"] ?? req.body?.max_depth ?? ""),
        10,
      );
      if (!combinations) {
        if (!isNaN(directMaxUrl) || !isNaN(directMaxDepth)) {
          combinations = [
            {
              maxUrl: !isNaN(directMaxUrl) ? directMaxUrl : 5,
              maxDepth: !isNaN(directMaxDepth) ? directMaxDepth : 5,
            },
          ];
        }
      }

      // 3. Defaults to the requested benchmark combinations with 5:5 as default
      if (!combinations || combinations.length === 0) {
        combinations = [
          { maxUrl: 5, maxDepth: 5 },
          { maxUrl: 10, maxDepth: 5 },
          { maxUrl: 15, maxDepth: 10 },
        ];
      }

      const benchmarkData = await this.orchestrator.runBenchmark({
        url: urlParam,
        urls: urlsParam,
        query: queryParam,
        searchLimit: !isNaN(searchLimit) ? searchLimit : undefined,
        seedLimit: !isNaN(seedLimit) ? seedLimit : undefined,
        multiDomain: multiDomainParam,
        allowExternal: allowExternalParam,
        combinations,
      });

      if (req.query["format"] === "html") {
        res.setHeader("Content-Type", "text/html");
        res.status(200).send(renderBenchmarkHtml(benchmarkData));
        return;
      }

      res.status(200).json({
        success: true,
        data: benchmarkData,
      });
    } catch (err) {
      next(err);
    }
  };
}

function renderHomeHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tavily Orchestrator API & Benchmark</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #090d16;
      --card: #111827;
      --border: #1f293d;
      --text: #f3f4f6;
      --text-dim: #9ca3af;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.2);
      --green: #34d399;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at top right, #1e1b4b 0%, var(--bg) 60%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      padding: 32px 16px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
    }
    .container { max-width: 900px; width: 100%; }
    .header { margin-bottom: 32px; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 999px;
      background: var(--accent-glow);
      color: var(--accent);
      border: 1px solid var(--accent);
      margin-bottom: 12px;
      letter-spacing: 0.5px;
    }
    h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.5px; }
    p.lead { color: var(--text-dim); font-size: 16px; line-height: 1.5; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    h2 { font-size: 20px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .url-chip {
      display: block;
      padding: 12px 16px;
      background: #0b1120;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
      font-size: 13.5px;
      color: #38bdf8;
      text-decoration: none;
      word-break: break-all;
      margin-bottom: 12px;
      transition: all 0.2s;
    }
    .url-chip:hover {
      background: #172554;
      border-color: #38bdf8;
      transform: translateY(-1px);
    }
    .url-chip span.label {
      display: inline-block;
      color: #93c5fd;
      font-weight: 600;
      margin-right: 8px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .param-item {
      background: #090e17;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .param-name { font-weight: 700; color: #f97316; font-size: 14px; margin-bottom: 4px; font-family: monospace; }
    .param-desc { font-size: 13px; color: var(--text-dim); line-height: 1.4; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="badge">TAVILY UNIFIED API ONLINE</div>
      <h1>Crawler, Search & Benchmark API</h1>
      <p class="lead">Configured with <strong>default max_url = 5</strong> and <strong>default max_depth = 5</strong>. All settings are configurable in your browser URL bar.</p>
    </div>

    <div class="card">
      <h2>🚀 Instant Test URLs (Click to Open)</h2>
      
      <a class="url-chip" href="/benchmark?q=LLM&max_url=15&max_depth=20" target="_blank">
        <span class="label">🌐 Multi-Domain Benchmark (Query):</span>
        http://localhost:4000/benchmark?q=LLM&max_url=15&max_depth=20
      </a>

      <a class="url-chip" href="/?q=LLM&crawl=true&max_url=15&max_depth=10" target="_blank">
        <span class="label">🕷️ Multi-Domain Crawl (Query):</span>
        http://localhost:4000/?q=LLM&crawl=true&max_url=15&max_depth=10
      </a>

      <a class="url-chip" href="/benchmark?url=https://en.wikipedia.org/wiki/TypeScript,https://www.typescriptlang.org&max_url=15&max_depth=10" target="_blank">
        <span class="label">🔀 Multi-Domain Comma URLs:</span>
        http://localhost:4000/benchmark?url=https://en.wikipedia.org/wiki/TypeScript,https://www.typescriptlang.org&max_url=15&max_depth=10
      </a>

      <a class="url-chip" href="/benchmark?url=https://example.com" target="_blank">
        <span class="label">📊 Single Domain Benchmark:</span>
        http://localhost:4000/benchmark?url=https://example.com
      </a>

      <a class="url-chip" href="/benchmark?url=https://en.wikipedia.org/wiki/TypeScript&combinations=5:2,10:3,15:5" target="_blank">
        <span class="label">🧪 Custom Combinations:</span>
        http://localhost:4000/benchmark?url=https://en.wikipedia.org/wiki/TypeScript&combinations=5:2,10:3,15:5
      </a>
    </div>

    <div class="card">
      <h2>⚙️ Available URL Parameters</h2>
      <div class="grid">
        <div class="param-item">
          <div class="param-name">q / url</div>
          <div class="param-desc">Seed URL(s) to crawl (supports comma-separated URLs) or search query.</div>
        </div>
        <div class="param-item">
          <div class="param-name">crawl=true</div>
          <div class="param-desc">Activates recursive BFS crawler across domains.</div>
        </div>
        <div class="param-item">
          <div class="param-name">multi_domain=true (default: true)</div>
          <div class="param-desc">Enables crawling across multiple distinct domains. Set false for single-domain.</div>
        </div>
        <div class="param-item">
          <div class="param-name">max_url (default: 5)</div>
          <div class="param-desc">Maximum number of pages to fetch and parse.</div>
        </div>
        <div class="param-item">
          <div class="param-name">max_depth (default: 5)</div>
          <div class="param-desc">Maximum link hop depth from seed pages.</div>
        </div>
        <div class="param-item">
          <div class="param-name">format=json</div>
          <div class="param-desc">Forces raw JSON output instead of the visual dashboard.</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderBenchmarkHtml(data: {
  targetUrl: string;
  targetUrls?: string[] | undefined;
  query?: string | undefined;
  totalSearchUrlsFound?: number | undefined;
  multiDomain?: boolean | undefined;
  allDomainsCrawled?: string[] | undefined;
  resolvedUrls?: string[] | undefined;
  searchTookMs?: number | undefined;
  totalCombinationsTested: number;
  results: Array<{
    combination: string;
    maxUrl: number;
    maxDepth: number;
    durationMs: number;
    durationSec: string;
    seedUrlsUsed?: number;
    pagesCrawled: number;
    pagesDiscovered: number;
    domainsCrawledCount?: number;
    domainsCrawled?: string[];
    totalBytes: number;
    avgPerPageMs: number;
    crawlId: string;
  }>;
}): string {
  const fastest = [...data.results].sort((a, b) => a.durationMs - b.durationMs)[0];

  const rows = data.results
    .map((r) => {
      const isFastest = r === fastest;
      return `<tr>
        <td style="font-weight: 600; font-family: monospace; color: #38bdf8;">${r.combination}</td>
        <td><span class="tag tag-blue">${r.maxUrl}</span></td>
        <td><span class="tag tag-purple">${r.maxDepth}</span></td>
        <td><span class="tag tag-green">${r.domainsCrawledCount ?? 1} domain${(r.domainsCrawledCount ?? 1) === 1 ? "" : "s"}</span></td>
        <td><span class="tag tag-blue">${r.seedUrlsUsed ?? 1} seeds</span></td>
        <td>
          <span style="font-size: 15px; font-weight: 700; color: ${isFastest ? "#34d399" : "#f3f4f6"};">
            ${r.durationMs}ms
          </span>
          <span style="color: #6b7280; font-size: 12px;">(${r.durationSec}s)</span>
          ${isFastest ? '<span class="tag tag-green" style="margin-left: 6px;">Fastest</span>' : ""}
        </td>
        <td>${r.pagesCrawled}</td>
        <td>${r.pagesDiscovered}</td>
        <td>${(r.totalBytes / 1024).toFixed(1)} KB</td>
        <td style="color: #93c5fd;">${r.avgPerPageMs}ms/page</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Crawler Performance Benchmark Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --bg: #090d16;
      --card: #111827;
      --border: #1f293d;
      --text: #f3f4f6;
      --text-dim: #9ca3af;
      --accent: #38bdf8;
      --green: #34d399;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at top right, #1e1b4b 0%, var(--bg) 60%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      padding: 32px 16px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
    }
    .container { max-width: 1050px; width: 100%; }
    .header { margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: gap; }
    h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.5px; }
    p.lead { color: var(--text-dim); font-size: 14px; margin-top: 4px; }
    .top-actions { display: flex; gap: 8px; }
    .btn {
      padding: 8px 14px;
      background: #1f293d;
      color: #38bdf8;
      border: 1px solid #374151;
      border-radius: 6px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .btn:hover { background: #374151; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      margin-bottom: 24px;
    }
    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      background: #0b1120;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .url-badge {
      font-family: monospace;
      color: #38bdf8;
      background: #082f49;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid #0369a1;
      font-size: 13px;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th {
      background: #0f172a;
      padding: 14px 16px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #9ca3af;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
    }
    .tag-blue { background: #0369a1; color: #bae6fd; }
    .tag-purple { background: #581c87; color: #e9d5ff; }
    .tag-green { background: #064e3b; color: #a7f3d0; }
    .quick-tests {
      padding: 18px 20px;
      background: #0c1322;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .quick-tests h3 { font-size: 14px; color: #9ca3af; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .quick-links { display: flex; flex-wrap: wrap; gap: 8px; }
    .quick-link {
      padding: 6px 12px;
      background: #111827;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 13px;
      color: #cbd5e1;
      text-decoration: none;
      font-family: monospace;
    }
    .quick-link:hover { border-color: #38bdf8; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>Crawler Benchmark Results</h1>
        <p class="lead">Matrix execution across requested max_url & max_depth combinations.</p>
      </div>
      <div class="top-actions">
        <a class="btn" href="${data.query ? `?q=${encodeURIComponent(data.query)}&format=json` : `?url=${encodeURIComponent(data.targetUrl)}&format=json`}" target="_blank">View Raw JSON</a>
        <a class="btn" href="/" style="background: #0284c7; color: white; border: none;">API Home</a>
      </div>
    </div>

    <div class="card">
      <div class="card-header" style="flex-direction: column; align-items: flex-start; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
          <div>
            ${
              data.query
                ? `<span style="font-weight: 700; font-size: 15px; color: #f97316;">Query: "${data.query}"</span> <span style="color: #9ca3af; font-size: 13px;">(${data.searchTookMs ?? 0}ms search latency)</span>`
                : '<span style="font-weight: 600; font-size: 14px;">Direct Target URL(s)</span>'
            }
          </div>
          <span class="url-badge">${data.targetUrl}</span>
        </div>
        ${
          data.totalSearchUrlsFound
            ? `<div style="font-size: 13px; color: #cbd5e1; margin-top: 4px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span class="tag tag-purple">⚡ Variable Search Seeds: ${data.totalSearchUrlsFound} URLs discovered</span>
                <span style="color: #9ca3af; font-size: 12px;">(all dynamically seeded across ${data.allDomainsCrawled ? data.allDomainsCrawled.length : 1} domains)</span>
              </div>`
            : ""
        }
        ${
          data.allDomainsCrawled && data.allDomainsCrawled.length > 0
            ? `<div style="font-size: 12.5px; color: #93c5fd; margin-top: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span class="tag tag-green">🌐 Multi-Domain Active (${data.allDomainsCrawled.length} domains):</span>
                ${data.allDomainsCrawled
                  .map(
                    (d) =>
                      `<span style="font-family: monospace; background: #082f49; border: 1px solid #0284c7; padding: 2px 7px; border-radius: 4px; color: #38bdf8;">${d}</span>`,
                  )
                  .join(" ")}
              </div>`
            : ""
        }
        ${
          data.targetUrls && data.targetUrls.length > 1
            ? `<div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">
                Seed URLs (${data.targetUrls.length}):
                ${data.targetUrls
                  .map(
                    (u) =>
                      `<a href="/benchmark?url=${encodeURIComponent(u)}" style="color: #38bdf8; text-decoration: underline; margin-left: 4px;" target="_blank">${u}</a>`,
                  )
                  .join(", ")}
              </div>`
            : ""
        }
      </div>
      <table>
        <thead>
          <tr>
            <th>Combination</th>
            <th>Max URLs</th>
            <th>Max Depth</th>
            <th>Domains</th>
            <th>Seeds Used</th>
            <th>Duration</th>
            <th>Crawled</th>
            <th>Discovered</th>
            <th>Total Bytes</th>
            <th>Average Speed</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>

    <div class="quick-tests">
      <h3>Test Queries & Combinations Directly in Browser:</h3>
      <div class="quick-links">
        <a class="quick-link" href="/benchmark?q=LLM&max_url=15&max_depth=20">?q=LLM (Multi-Domain 15:20)</a>
        <a class="quick-link" href="/benchmark?q=LLM&search_limit=15&max_url=15&max_depth=10">?q=LLM (15 Search Seeds)</a>
        <a class="quick-link" href="/benchmark?q=LLM&max_url=15&max_depth=20&multi_domain=false">?q=LLM (Single Domain only)</a>
        <a class="quick-link" href="/benchmark?url=https://en.wikipedia.org/wiki/TypeScript,https://www.typescriptlang.org&max_url=15&max_depth=10">Multi-Seed URLs (Wikipedia + TS)</a>
        <a class="quick-link" href="/benchmark?q=artificial+intelligence&max_url=10&max_depth=5">?q=artificial intelligence</a>
        <a class="quick-link" href="/benchmark?url=https://example.com&max_url=10&max_depth=5">example.com (10:5)</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string = ""): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

interface CrawlHtmlPage {
  url: string;
  state?: string;
  statusCode?: number;
  depth?: number;
  tookMs?: number;
  markdown?: string;
  metadata?: {
    title?: string;
  };
}

interface CrawlHtmlPayload {
  query?: string;
  seedUrl?: string;
  tookMs?: number;
  crawl?: {
    crawlId?: string;
    pages?: CrawlHtmlPage[];
    stats?: {
      totalBytes?: number;
    };
  };
}

function renderCrawlHtml(data: CrawlHtmlPayload): string {
  const crawlId = data.crawl?.crawlId || "unknown";
  const tookSec = ((data.tookMs || 0) / 1000).toFixed(2);
  const pages = data.crawl?.pages || [];
  const completedCount = pages.filter((p) => p.state === "COMPLETED").length;
  const isFast = (data.tookMs || 0) <= 4000;
  const rate = ((pages.length || 1) / Math.max((data.tookMs || 0) / 1000, 0.1)).toFixed(1);
  const kbTotal = ((data.crawl?.stats?.totalBytes || 0) / 1024 || 0).toFixed(1);
  const combinedMd = pages
    .map(
      (p, idx) =>
        `# Page ${idx + 1}: ${p.metadata?.title || p.url}\n\n**Source URL:** [${p.url}](${p.url})\n**Depth:** ${p.depth} | **Status:** ${p.statusCode}\n\n${p.markdown}\n\n---\n`,
    )
    .join("\n");

  const pageCards = pages
    .map((p, idx) => {
      let hostname: string;
      try {
        hostname = new URL(p.url).hostname;
      } catch {
        hostname = "domain";
      }
      const pageNum = String(idx + 1).padStart(4, "0");
      const pageMdUrl = `/storage/crawls/${crawlId}/page-${pageNum}.md`;
      const isOk = p.state === "COMPLETED" && (p.statusCode === 200 || !p.statusCode);

      return `
      <div class="page-card">
        <div class="page-header">
          <div class="page-title-row">
            <span class="page-idx">#${idx + 1}</span>
            <span class="domain-tag">${escapeHtml(hostname)}</span>
            <span class="status-badge ${isOk ? "badge-success" : "badge-warn"}">${p.statusCode || p.state}</span>
            <span class="depth-badge">Depth: ${p.depth}</span>
            <span class="time-badge">${p.tookMs}ms</span>
          </div>
          <h3 class="page-title"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.metadata?.title || p.url)}</a></h3>
          <div class="page-url">${escapeHtml(p.url)}</div>
        </div>
        <div class="page-actions">
          <a class="btn btn-sm btn-ghost" href="${pageMdUrl}" target="_blank">📄 View page-${pageNum}.md</a>
          <button class="btn btn-sm btn-outline" onclick="copySnippet(this, 'snippet-${idx}')">📋 Copy Markdown</button>
        </div>
        <div class="page-content">
          <div class="preview-text">${escapeHtml((p.markdown || "").slice(0, 350))}${(p.markdown || "").length > 350 ? "..." : ""}</div>
          <textarea id="snippet-${idx}" style="display:none;">${escapeHtml(p.markdown || "")}</textarea>
        </div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Crawl Results - ${escapeHtml(data.query || data.seedUrl || "Crawl")}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e;
      --card-bg: #0f172a;
      --card-border: rgba(255, 255, 255, 0.08);
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.25);
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.2);
      --purple: #8b5cf6;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: 'JetBrains Mono', Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 10% 10%, #172554 0%, var(--bg) 60%);
      color: var(--text);
      font-family: var(--font);
      padding: 32px 20px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
    }
    .container { max-width: 1100px; width: 100%; }
    .header {
      margin-bottom: 28px;
    }
    .badge-top {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: var(--accent-glow);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.3);
      margin-bottom: 12px;
    }
    .header h1 {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .header p {
      color: var(--text-muted);
      font-size: 14px;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      position: relative;
      overflow: hidden;
    }
    .metric-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, var(--accent), var(--purple));
    }
    .metric-card.success::before {
      background: linear-gradient(90deg, var(--emerald), var(--accent));
    }
    .metric-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .metric-val {
      font-size: 24px;
      font-weight: 800;
      color: #fff;
    }
    .metric-sub {
      font-size: 11px;
      color: var(--emerald);
      margin-top: 4px;
      font-weight: 600;
    }
    .storage-banner {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.95));
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 14px;
      padding: 20px 24px;
      margin-bottom: 28px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 0 20px var(--accent-glow);
    }
    .storage-title {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .storage-paths {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text-muted);
      background: rgba(0, 0, 0, 0.4);
      padding: 12px 14px;
      border-radius: 8px;
      margin-bottom: 16px;
      line-height: 1.6;
      word-break: break-all;
    }
    .storage-paths strong {
      color: var(--accent);
    }
    .action-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 8px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s ease;
      border: none;
      font-family: var(--font);
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), #0284c7);
      color: #041226;
      font-weight: 700;
      box-shadow: 0 4px 12px rgba(56, 189, 248, 0.3);
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(56, 189, 248, 0.4);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #f1f5f9;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
    }
    .btn-accent {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
    }
    .btn-accent:hover {
      background: #059669;
    }
    .btn-sm {
      padding: 6px 12px;
      font-size: 11px;
    }
    .btn-ghost {
      background: transparent;
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .btn-ghost:hover {
      background: var(--accent-glow);
    }
    .btn-outline {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--card-border);
    }
    .btn-outline:hover {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.3);
    }
    .controls-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 28px;
    }
    .controls-form {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .form-group label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
    }
    .form-input {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: #fff;
      padding: 8px 12px;
      font-size: 13px;
      font-family: var(--font);
    }
    .form-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .pages-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .pages-header h2 {
      font-size: 18px;
      font-weight: 700;
    }
    .pages-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .page-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px 20px;
      transition: border-color 0.15s ease;
    }
    .page-card:hover {
      border-color: rgba(56, 189, 248, 0.4);
    }
    .page-header {
      margin-bottom: 12px;
    }
    .page-title-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .page-idx {
      font-weight: 800;
      font-size: 13px;
      color: var(--accent);
    }
    .domain-tag {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
    }
    .status-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .badge-success { background: var(--emerald-glow); color: var(--emerald); }
    .badge-warn { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .depth-badge {
      font-size: 11px;
      color: var(--text-muted);
    }
    .time-badge {
      font-size: 11px;
      font-family: var(--mono);
      color: var(--text-muted);
      margin-left: auto;
    }
    .page-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .page-title a {
      color: #f1f5f9;
      text-decoration: none;
    }
    .page-title a:hover {
      color: var(--accent);
      text-decoration: underline;
    }
    .page-url {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      word-break: break-all;
    }
    .page-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    .preview-text {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.6;
      color: #cbd5e1;
      white-space: pre-wrap;
      font-family: var(--font);
    }
    textarea#full-markdown {
      width: 100%;
      height: 350px;
      background: #050811;
      color: #e2e8f0;
      font-family: var(--mono);
      font-size: 12px;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
      line-height: 1.5;
      resize: vertical;
      margin-top: 12px;
    }
    .copied-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--emerald);
      color: #fff;
      font-weight: 700;
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 10px 20px rgba(0,0,0,0.4);
      display: none;
      z-index: 9999;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="badge-top">⚡ Tavily Parallel Worker Crawler (Pool: 16 Concurrency)</div>
      <h1>Crawl Results: "${escapeHtml(data.query || data.seedUrl)}"</h1>
      <p>Crawl ID: <code style="color:var(--accent);">${escapeHtml(crawlId)}</code> &bull; Seed URLs resolved across organic multi-domain web results.</p>
    </div>

    <div class="metrics-grid">
      <div class="metric-card ${isFast ? "success" : ""}">
        <div class="metric-label">Execution Time</div>
        <div class="metric-val">${tookSec}s</div>
        <div class="metric-sub">${isFast ? "⚡ Target &le; 3.5s Met!" : "Duration in seconds"}</div>
      </div>
      <div class="metric-card success">
        <div class="metric-label">Pages Crawled</div>
        <div class="metric-val">${completedCount} / ${pages.length}</div>
        <div class="metric-sub">Parallel workers pool</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Crawl Speed</div>
        <div class="metric-val">${rate} <span style="font-size:14px;font-weight:600;color:var(--text-muted);">pg/s</span></div>
        <div class="metric-sub">Concurrent throughput</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Payload Downloaded</div>
        <div class="metric-val">${kbTotal} <span style="font-size:14px;font-weight:600;color:var(--text-muted);">KB</span></div>
        <div class="metric-sub">${data.crawl?.stats?.totalDiscovered || pages.length} URLs discovered</div>
      </div>
    </div>

    <div class="storage-banner">
      <div class="storage-title">
        <span>💾 Crawled Markdown Files Generated & Persisted to Disk</span>
      </div>
      <div class="storage-paths">
        <strong>Unified File:</strong> ${escapeHtml(data.markdownFiles?.combined || data.storageInfo?.combinedMarkdownPath || "storage/crawls/" + crawlId + "/crawl.md")}<br>
        <strong>Global Latest:</strong> ${escapeHtml(data.markdownFiles?.latest || data.storageInfo?.latestMarkdownPath || "storage/latest_crawl.md")}<br>
        <strong>Storage Dir:</strong> ${escapeHtml(data.markdownFiles?.directory || data.storageInfo?.crawlDir || "storage/crawls/" + crawlId)}
      </div>
      <div class="action-row">
        <a class="btn btn-primary" href="/latest_crawl.md" download="crawl.md">⬇️ Download Unified crawl.md</a>
        <a class="btn btn-secondary" href="/latest_crawl.md" target="_blank">🔍 Open latest_crawl.md (Raw Text)</a>
        <button class="btn btn-accent" onclick="copyFullMarkdown()">📋 Copy Full Consolidated Markdown</button>
      </div>
    </div>

    <div class="controls-card">
      <form class="controls-form" method="GET" action="/">
        <input type="hidden" name="crawl" value="true">
        <div class="form-group" style="flex: 2; min-width: 200px;">
          <label>Query or Seed URL</label>
          <input class="form-input" type="text" name="q" value="${escapeHtml(data.query || data.seedUrl)}" required>
        </div>
        <div class="form-group" style="width: 100px;">
          <label>Max URLs</label>
          <input class="form-input" type="number" name="max_url" value="${pages.length || 10}" min="1" max="100">
        </div>
        <div class="form-group" style="width: 100px;">
          <label>Depth</label>
          <input class="form-input" type="number" name="max_depth" value="2" min="1" max="20">
        </div>
        <div class="form-group" style="margin-top: 18px;">
          <button class="btn btn-primary" type="submit">⚡ Re-run Crawl</button>
        </div>
      </form>
    </div>

    <div class="pages-header">
      <h2>Crawled Pages Showcase (${pages.length} Pages)</h2>
      <a class="btn btn-sm btn-outline" href="/?q=${encodeURIComponent(data.query || "")}&crawl=true&max_url=${pages.length}&max_depth=2&format=json" target="_blank">{ } View JSON API Payload</a>
    </div>

    <div class="pages-list">
      ${pageCards}
    </div>

    <div style="margin-top: 36px;">
      <h3 style="margin-bottom: 8px;">Consolidated Markdown Content (All Pages Combined):</h3>
      <textarea id="full-markdown" readonly>${escapeHtml(combinedMd)}</textarea>
    </div>
  </div>

  <div id="toast" class="copied-toast">✓ Markdown copied to clipboard!</div>

  <script>
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg || '✓ Copied to clipboard!';
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 2200);
    }
    function copySnippet(btn, id) {
      const text = document.getElementById(id).value;
      navigator.clipboard.writeText(text).then(() => {
        showToast('✓ Page Markdown copied!');
      });
    }
    function copyFullMarkdown() {
      const text = document.getElementById('full-markdown').value;
      navigator.clipboard.writeText(text).then(() => {
        showToast('✓ Full consolidated Markdown copied!');
      });
    }
  </script>
</body>
</html>`;
}
