export interface SearchResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
  [key: string]: unknown;
}

export interface SearchResponse {
  query: string;
  number_of_results?: number;
  results: SearchResult[];
  [key: string]: unknown;
}

export class SearchService {
  private readonly baseUrl: string;

  constructor() {
    const baseUrl = process.env.BASE_URL ?? "http://localhost:8080"
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async search(query: string): Promise<SearchResponse> {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      throw new Error("Search query cannot be empty");
    }

    const url = new URL("/search", `${this.baseUrl}/`);

    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("format", "json");

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `SearXNG request failed: ${response.status} ${response.statusText}`
      );
    }

    const data: unknown = await response.json();

    if (
      !data ||
      typeof data !== "object" ||
      !("results" in data) ||
      !Array.isArray(data.results)
    ) {
      throw new Error("SearXNG returned an invalid response");
    }

    return data as SearchResponse;
  }
}