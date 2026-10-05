// Client for the Go scraper service (packages/scraper, `cmd/server`).
// Mirrors SearchService: a thin HTTP wrapper that validates the response shape and
// leaves result shaping to the controller.

export interface ScrapedPageMetadata {
  description?: string;
  keywords?: string[];
  og_title?: string;
  og_description?: string;
  og_image?: string;
  canonical?: string;
  lang?: string;
  author?: string;
  published_date?: string;
  modified_date?: string;
}

// One entry of the scraper's `results` array (types.ScrapeResult in Go, minus raw HTML)
export interface ScrapedPage {
  url: string;
  success: boolean;
  method: string;
  title: string;
  text: string;
  markdown: string;
  structured_data: unknown[] | null;
  metadata: ScrapedPageMetadata;
  links: string[] | null;
  error?: string;
  cached?: boolean;
  timing: {
    fetch_ms: number;
    extract_ms: number;
    total_ms: number;
  };
}

export interface ScrapeResponse {
  results: ScrapedPage[];
  took_ms: number;
}

// Thrown when the scraper service itself cannot be used (down, timed out, bad reply).
// Per-URL failures are not errors: they come back as results with success=false.
export class ScraperError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScraperError";
  }
}

export class ScraperService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    const baseUrl = process.env.SCRAPER_URL ?? "http://localhost:8081";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    // Must exceed the scraper's own SCRAPER_BATCH_TIMEOUT_SEC (30s) so the Go side
    // returns partial results before we give up on it
    this.timeoutMs = Number(process.env.SCRAPER_TIMEOUT_MS) || 35_000;
  }

  async scrape(urls: string[]): Promise<ScrapedPage[]> {
    if (urls.length === 0) {
      return [];
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ScraperError(
        `Scraper request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ScraperError(
        `Scraper request failed: ${response.status} ${response.statusText} ${body}`.trim()
      );
    }

    const data: unknown = await response.json();

    if (
      !data ||
      typeof data !== "object" ||
      !("results" in data) ||
      !Array.isArray(data.results) ||
      data.results.length !== urls.length
    ) {
      throw new ScraperError("Scraper returned an invalid response");
    }

    return data.results as ScrapedPage[];
  }
}
