import { CrawlerEngine } from "./core/engine.js";
import { FileSystemStorage } from "./storage/file.storage.js";
import { getScrapingConfig } from "./config.js";

function printHelp(): void {
  console.log(`
Tavily Crawler & Scraper Engine CLI

Usage:
  tsx src/cli.ts <command> [options]

Commands:
  extract <url...>             Scrape one or more URLs directly to Markdown
  extract --query "<query>"    Scrape top URLs resolved from Search service
  map <url>                    Map discovered URLs using sitemaps and shallow BFS
  crawl <url>                  Deep recursive BFS crawl and persist to disk

Options:
  --limit <n>                  Maximum pages to crawl / map (default: 50 for crawl, 100 for map)
  --depth <n>                  Maximum BFS depth (default: 2)
  --images                     Include image tags in extracted markdown
  --playwright                 Enable dynamic browser fallback for SPAs
  --storage <dir>              Directory to persist crawl results (default: ./storage)
  --help                       Show this help message

Examples:
  pnpm cli extract https://example.com
  pnpm cli extract --query "best places to visit in India"
  pnpm cli map https://example.com --depth 2 --limit 50
  pnpm cli crawl https://example.com --limit 30 --depth 2
`);
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printHelp();
    return;
  }

  const { flags, positional } = parseArgs(rawArgs);
  const command = positional[0]?.toLowerCase();
  const target = positional[1];

  const config = getScrapingConfig();
  const storageDir = typeof flags["storage"] === "string" ? flags["storage"] : config.storageDir;
  const storage = new FileSystemStorage(storageDir);
  const engine = new CrawlerEngine({ storage });

  const limit = typeof flags["limit"] === "string" ? parseInt(flags["limit"], 10) : undefined;
  const depth = typeof flags["depth"] === "string" ? parseInt(flags["depth"], 10) : undefined;
  const includeImages = Boolean(flags["images"]);
  const fallbackToPlaywright = Boolean(flags["playwright"]);
  const query = typeof flags["query"] === "string" ? flags["query"] : undefined;

  switch (command) {
    case "extract": {
      const urls = positional.slice(1);
      if (urls.length === 0 && !query) {
        console.error("Error: Please provide at least one URL or a --query parameter.");
        process.exit(1);
      }

      console.log(`Extracting ${urls.length > 0 ? urls.join(", ") : `query: "${query}"`}...`);
      const res = await engine.extract({
        urls: urls.length > 0 ? urls : undefined,
        query,
        includeImages,
        fallbackToPlaywright,
      });

      console.log(`\n=== Extracted ${res.results.length} Page(s) in ${res.tookMs}ms ===\n`);
      for (const result of res.results) {
        console.log(`--- [${result.title || "No Title"}] (${result.url}) ---`);
        console.log(
          result.markdown.slice(0, 500) + (result.markdown.length > 500 ? "\n...[truncated]" : ""),
        );
        console.log(`\n(Outbound Links: ${result.outboundLinks.length})\n`);
      }

      if (res.errors.length > 0) {
        console.warn(`Failed URLs (${res.errors.length}):`, res.errors);
      }
      break;
    }

    case "map": {
      if (!target) {
        console.error("Error: Missing target URL for map command.");
        process.exit(1);
      }

      console.log(`Mapping topology for ${target}...`);
      const res = await engine.map({
        url: target,
        maxDepth: depth ?? 2,
        limit: limit ?? 100,
      });

      console.log(`\n=== Discovered ${res.totalUrls} URLs in ${res.durationMs}ms ===\n`);
      for (const url of res.urls) {
        console.log(`- ${url}`);
      }
      break;
    }

    case "crawl": {
      if (!target) {
        console.error("Error: Missing target URL for crawl command.");
        process.exit(1);
      }

      console.log(`Initiating crawl for ${target}...`);
      const res = await engine.crawl({
        url: target,
        limit: limit ?? 50,
        maxDepth: depth ?? 2,
        enablePlaywrightFallback: fallbackToPlaywright,
      });

      console.log(`\n=== Crawl Finished: ID ${res.crawlId} ===`);
      console.log(`Total Crawled: ${res.stats.totalCrawled}`);
      console.log(`Total Discovered: ${res.stats.totalDiscovered}`);
      console.log(`Total Failed: ${res.stats.totalFailed}`);
      console.log(`Duration: ${res.stats.durationMs}ms`);
      console.log(`Stored output at: ${storageDir}/crawls/${res.crawlId}\n`);
      break;
    }

    default: {
      console.error(`Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});
