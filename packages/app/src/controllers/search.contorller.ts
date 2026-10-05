import { type Request, type Response } from "express";
import { SearchService, type SearchResult } from "../services/search.service.js";
import {
  ScraperService,
  ScraperError,
  type ScrapedPage,
} from "../services/scraper.service.js";
import ApiResponse from "../utils/api-response.js";
import ApiError from "../utils/api-error.js";

// How many of SearXNG's results are passed on to the scraper. Must not exceed the
// scraper's SCRAPER_MAX_URLS or it rejects the batch.
const MAX_SCRAPE_URLS = Number(process.env.MAX_SCRAPE_URLS) || 20;

// What the API returns per URL: scraped content when the scrape worked, otherwise the
// SearXNG snippet so a failed page still contributes something.
export interface SearchResultItem {
  url: string;
  title: string;
  content: string;
  description?: string;
  published_date?: string;
  success: boolean;
  error?: string;
  scrape_method?: string;
  scrape_ms?: number;
}

export const searchController = async (
  req: Request,
  res: Response
) => {
  try {
    const query = req.query.q;

    if (typeof query !== "string" || !query.trim()) {
      throw new ApiError(
        400,
        "Search query is required"
      );
    }

    const searchService = new SearchService();
    const scraperService = new ScraperService();

    // 1. Search: SearXNG → ranked results
    const data = await searchService.search(query);
    const candidates = pickScrapeCandidates(data.results, MAX_SCRAPE_URLS);

    // 2. Scrape: top-N URLs → page content. Per-URL failures come back inline;
    //    only the service being unreachable is an error.
    let pages: ScrapedPage[] = [];
    try {
      pages = await scraperService.scrape(candidates.map((c) => c.url));
    } catch (error) {
      if (error instanceof ScraperError) {
        throw new ApiError(502, "Scraper service unavailable", error.message);
      }
      throw error;
    }

    // 3. Merge: the scraper returns results in input order
    const results = candidates.map((candidate, i) =>
      toSearchResultItem(candidate, pages[i])
    );
    const scraped = results.filter((r) => r.success).length;

    return res.status(200).json(
      new ApiResponse(
        200,
        "Search successful",
        {
          query,
          total: results.length,
          scraped,
          failed: results.length - scraped,
          results,
        }
      )
    );

  } catch (error) {
    console.error("Search error:", error);

    if (error instanceof ApiError) {
      return res.status(error.statusCode).json(
        new ApiResponse(
          error.statusCode,
          error.message,
          error.errors
        )
      );
    }

    return res.status(500).json(
      new ApiResponse(
        500,
        "Search failed",
        null
      )
    );
  }
};

type ScrapeCandidate = SearchResult & { url: string };

// Keep the first `limit` results that have a usable http(s) URL, dropping duplicates
function pickScrapeCandidates(
  results: SearchResult[],
  limit: number
): ScrapeCandidate[] {
  const seen = new Set<string>();
  const picked: ScrapeCandidate[] = [];

  for (const result of results) {
    if (picked.length >= limit) break;

    const url = result.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    picked.push({ ...result, url });
  }
  return picked;
}

function toSearchResultItem(
  candidate: ScrapeCandidate,
  page: ScrapedPage | undefined
): SearchResultItem {
  const snippet = candidate.content ?? "";

  if (!page || !page.success) {
    return {
      url: candidate.url,
      title: candidate.title ?? "",
      content: snippet,
      success: false,
      error: page?.error ?? "No scrape result returned",
    };
  }

  const item: SearchResultItem = {
    url: candidate.url,
    title: page.title || candidate.title || "",
    content: page.text || snippet,
    success: true,
    scrape_method: page.cached ? `cached ${page.method}` : page.method,
    scrape_ms: page.timing.total_ms,
  };

  // exactOptionalPropertyTypes: only set these when there is a value
  const description = page.metadata.description || page.metadata.og_description;
  if (description) item.description = description;
  if (page.metadata.published_date) item.published_date = page.metadata.published_date;

  return item;
}
