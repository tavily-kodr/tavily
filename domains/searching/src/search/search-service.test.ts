import axios from "axios";
import { AppError } from "@tavily/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureSearxngClient,
  OPTIONAL_PAGE_DEADLINE_MS,
  PAGE_DEADLINE_MS,
} from "../searxng/searxng-client.js";
import { configureSearchCache, SEARCH_BUDGET_MS, webSearch } from "./search-service.js";

describe("webSearch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    configureSearchCache();
    configureSearxngClient();
  });

  it("rejects an empty query", async () => {
    await expect(webSearch("   ")).rejects.toThrow("Query must not be empty");
  });

  describe("maxResults validation", () => {
    it.each([0, -1, 2.5, 21])("rejects invalid maxResults %s", async (value) => {
      await expect(webSearch("valid query", value)).rejects.toThrow(
        "maxResults must be an integer between 1 and 20",
      );
    });

    it("accepts valid positive integer maxResults (1, 10)", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: { query: "q", results: [] },
      });

      await expect(webSearch("valid query", 1)).resolves.toMatchObject({
        results: [],
        partial: false,
      });
      await expect(webSearch("valid query", 10)).resolves.toMatchObject({
        results: [],
        partial: false,
      });
    });
  });

  describe("runtime Zod response validation", () => {
    it("accepts a valid SearXNG response", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: {
          query: "q",
          results: [
            {
              title: "Valid Title",
              url: "https://example.com",
              content: "Valid snippet",
              engine: "bing",
              engines: ["bing"],
            },
          ],
          unresponsive_engines: [],
        },
      });

      const res = await webSearch("valid response test", 5);
      expect(res.results).toHaveLength(1);
      expect(res.results[0]?.url).toBe("https://example.com");
    });

    it("accepts a valid SearXNG response omitting optional fields", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: {
          results: [{ title: "No Snippet", url: "https://no-snippet.com" }],
        },
      });

      const res = await webSearch("optional fields test", 5);
      expect(res.results).toHaveLength(1);
      expect(res.results[0]?.url).toBe("https://no-snippet.com");
    });

    it("throws AppError on malformed response (non-object or null)", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: "<html>502 Bad Gateway</html>",
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const err = await webSearch("malformed non-object").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
      });
    });

    it("throws AppError when required 'results' field is missing", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: { query: "q" },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const err = await webSearch("missing results field").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
      });
    });

    it("throws AppError when field types are invalid (results is not an array)", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: { query: "q", results: "invalid-not-array" },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const err = await webSearch("invalid results type").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
      });
    });

    it("throws AppError when result item has invalid field type (url is a number)", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: {
          query: "q",
          results: [{ title: "Item", url: 12345 }],
        },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const err = await webSearch("invalid url type").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
      });
    });

    it("throws AppError when result item has invalid field type (engines is not an array)", async () => {
      vi.spyOn(axios, "get").mockResolvedValue({
        data: {
          query: "q",
          results: [{ title: "Item", url: "https://example.com", engines: "not-an-array" }],
        },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const err = await webSearch("invalid engines type").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
      });
    });
  });

  describe("partial failure handling", () => {
    type Page = { results?: unknown[]; unresponsive_engines?: unknown } | Error;

    function mockPages(pages: Record<number, Page>) {
      return vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        const pageno = (config?.params as { pageno: number }).pageno;
        const page = pages[pageno];
        if (page instanceof Error) throw page;
        return { data: { query: "q", results: [], ...page } };
      });
    }

    const item = (n: number | string, extra: Record<string, unknown> = {}) => ({
      title: `Python ${n}`,
      url: `https://site${n}.com`,
      content: "python",
      engine: "bing",
      ...extra,
    });

    it("sets partial = false when all pages succeed without engine errors", async () => {
      mockPages({
        1: { results: [item(1)] },
        2: { results: [item(2)] },
      });

      const res = await webSearch("all succeed", 10);
      expect(res.results).toHaveLength(2);
      expect(res.partial).toBe(false);
    });

    it("sets partial = true and preserves results when some pages fail (page 1 succeeds, page 2 fails)", async () => {
      mockPages({
        1: { results: [item(1)] },
        2: new Error("page 2 timeout"),
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const res = await webSearch("partial page 2 fails", 10);
      expect(res.results).toHaveLength(1);
      expect(res.results[0]?.url).toBe("https://site1.com");
      expect(res.partial).toBe(true);
    });

    it("retries page 1 once and continues when the retry succeeds", async () => {
      let page1Calls = 0;
      vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        const pageno = (config?.params as { pageno: number }).pageno;
        if (pageno === 1 && page1Calls++ === 0) throw new Error("page 1 failed");
        return { data: { query: "q", results: pageno <= 2 ? [item(pageno)] : [] } };
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const res = await webSearch("partial page 1 retried", 10);
      expect(page1Calls).toBe(2);
      expect(res.results.map((r) => r.url).sort()).toEqual([
        "https://site1.com",
        "https://site2.com",
      ]);
      expect(res.partial).toBe(false);
    });

    it("sets partial = true when all pages succeed but an engine is unresponsive", async () => {
      mockPages({
        1: { results: [item(1)], unresponsive_engines: [["brave", "timeout"]] },
        2: { results: [item(2)] },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const res = await webSearch("partial engine error", 10);
      expect(res.partial).toBe(true);
      expect(res.failedEngines).toEqual([{ engine: "brave", reason: "timeout" }]);
    });

    it("preserves complete failure error behavior when all pages fail across retries", async () => {
      vi.spyOn(axios, "get").mockRejectedValue(new Error("searxng down"));
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(webSearch("all pages fail")).rejects.toThrow(
        "SearXNG request failed after retry: searxng down",
      );
    });
  });

  it("dedupes, ranks, limits and caches SearXNG results", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [
          { title: "A python", url: "https://a.com/", content: "python", engine: "bing" },
          { title: "B python", url: "https://b.com", content: "python", engine: "bing" },
          { title: "", url: "http://b.com", content: "python", engine: "brave" },
        ],
      },
    });

    const first = await webSearch("mapped python", 5);
    expect(first.cached).toBe(false);
    expect(first.partial).toBe(false);
    // b.com was returned by two engines, so RRF ranks it first.
    expect(first.results.map((r) => r.url)).toEqual(["https://b.com", "https://a.com/"]);
    expect(first.results[0]?.score).toBe(1);
    expect(get.mock.calls[0]?.[1]?.params).toMatchObject({
      language: "en-US",
      categories: "general",
    });
    expect(get.mock.calls[0]?.[1]?.params).not.toHaveProperty("time_range");

    const second = await webSearch("Mapped Python ", 5);
    expect(second.cached).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("uses SearXNG's engines list for fusion", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [
          { title: "One", url: "https://one.com", content: "python", engine: "bing" },
          {
            title: "Two",
            url: "https://two.com",
            content: "python",
            engine: "bing",
            engines: ["bing", "brave", "mojeek"],
          },
        ],
      },
    });

    const res = await webSearch("engines python", 5);
    expect(res.results[0]?.url).toBe("https://two.com");
  });

  it("passes topic and time_range to SearXNG and applies domain filters", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [
          { title: "Python", url: "https://docs.python.org/3", content: "python" },
          { title: "Python", url: "https://news.python.org/x", content: "python" },
          { title: "Python", url: "https://other.com", content: "python" },
        ],
      },
    });

    const res = await webSearch("python news", 5, {
      topic: "news",
      timeRange: "week",
      includeDomains: ["python.org"],
      excludeDomains: ["news.python.org"],
    });

    expect(get.mock.calls[0]?.[1]?.params).toMatchObject({
      categories: "news",
      time_range: "week",
    });
    expect(res.results.map((r) => r.url)).toEqual(["https://docs.python.org/3"]);
  });

  it("limits to maxResults after ranking", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [1, 2, 3].map((i) => ({
          title: `Python ${i}`,
          url: `https://${i}.com`,
          content: "python",
          engine: "bing",
        })),
      },
    });

    const res = await webSearch("limit python", 2);
    expect(res.results.map((r) => r.url)).toEqual(["https://1.com", "https://2.com"]);
  });

  it("retries once, then throws", async () => {
    const get = vi.spyOn(axios, "get").mockRejectedValue(new Error("boom"));
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(webSearch("failing query")).rejects.toThrow(
      "SearXNG request failed after retry: boom",
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("handles empty SearXNG results array", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "empty",
        results: [],
      },
    });

    const res = await webSearch("query with no results", 5);
    expect(res.cached).toBe(false);
    expect(res.results).toEqual([]);
  });

  it("reports unresponsive engines as partial and caches the response briefly", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "p",
        results: [{ title: "A", url: "https://a.com", content: "partial" }],
        unresponsive_engines: [["brave", "timeout"]],
      },
    });

    const res = await webSearch("partial query", 5);
    expect(res.partial).toBe(true);
    expect(res.failedEngines).toEqual([{ engine: "brave", reason: "timeout" }]);

    const again = await webSearch("partial query", 5);
    expect(again).toMatchObject({ cached: true, partial: true });
    expect(again.failedEngines).toEqual([{ engine: "brave", reason: "timeout" }]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("hard-drops excluded domains but only ranks soft-filter failures down", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "f",
        results: [
          { title: "Bad", url: "https://www.bad.example/x", content: "filter" },
          { title: "No content", url: "https://empty.com", content: "" },
          { title: "Питон", url: "https://ru.example", content: "filter" },
          { title: "Good", url: "https://good.com", content: "filter" },
        ],
      },
    });

    const res = await webSearch("filter query", 10, { excludeDomains: ["bad.example"] });
    expect(res.filtered).toBe(true);
    expect(res.results[0]?.url).toBe("https://good.com");
    expect(res.results.map((r) => r.url).sort()).toEqual([
      "https://empty.com",
      "https://good.com",
      "https://ru.example",
    ]);
    expect(res.results.find((r) => r.url === "https://empty.com")?.snippet).toBe("No content");
  });

  it("returns results for a query made of numbers and years only", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [{ title: "Calendar", url: "https://cal.com", content: "dates", engine: "bing" }],
      },
    });

    const res = await webSearch("2026", 5);
    expect(res.results).toHaveLength(1);
    expect(res.filtered).toBe(true);
  });

  it("ignores years in the query when matching results", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [
          {
            title: "Year 2026 guide",
            url: "https://year.com",
            content: "10 in 2026",
            engine: "bing",
          },
          {
            title: "Top singer list",
            url: "https://singer.com",
            content: "singer",
            engine: "bing",
          },
        ],
      },
    });

    const res = await webSearch("top 10 singer in 2026", 5);
    expect(res.results[0]?.url).toBe("https://singer.com");
  });

  it("returns unfiltered results with filtered:false when every result fails quality checks", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [
          { title: "如何评价", url: "https://zhihu.example/1", content: "知乎", engine: "bing" },
          { title: "百度经验", url: "https://baidu.example/2", content: "", engine: "bing" },
        ],
      },
    });

    const res = await webSearch("all filtered query", 5);
    expect(res.filtered).toBe(false);
    expect(res.results.map((r) => r.url)).toEqual([
      "https://zhihu.example/1",
      "https://baidu.example/2",
    ]);
  });

  it("still drops excluded domains when falling back to unfiltered results", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [{ title: "x", url: "https://blocked.example", content: "y", engine: "bing" }],
      },
    });

    const res = await webSearch("blocked only query", 5, { excludeDomains: ["blocked.example"] });
    expect(res.results).toEqual([]);
  });

  it("throws a structured 503 when raw is empty and every expected engine failed", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [],
        unresponsive_engines: [
          ["bing", "timeout"],
          ["brave", "Suspended: too many requests"],
        ],
      },
    });

    const err = await webSearch("all engines down", 5, {
      expectedEngines: ["bing", "brave"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: "ALL_ENGINES_FAILED",
      statusCode: 503,
      details: {
        failedEngines: [
          { engine: "bing", reason: "timeout" },
          { engine: "brave", reason: "Suspended: too many requests" },
        ],
      },
    });
  });

  it("returns an empty partial 200 when raw is empty and only some engines failed", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(axios, "get").mockResolvedValue({
      data: { query: "q", results: [], unresponsive_engines: [["brave", "timeout"]] },
    });

    const res = await webSearch("some engines down", 5, { expectedEngines: ["bing", "brave"] });
    expect(res.results).toEqual([]);
    expect(res.partial).toBe(true);
    expect(res.failedEngines).toEqual([{ engine: "brave", reason: "timeout" }]);
  });

  it("returns results with partial:true when some engines failed", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "q",
        results: [{ title: "Some match", url: "https://m.com", content: "some", engine: "bing" }],
        unresponsive_engines: [["duckduckgo", "CAPTCHA"]],
      },
    });

    const res = await webSearch("some match", 5, { expectedEngines: ["bing", "duckduckgo"] });
    expect(res.results).toHaveLength(1);
    expect(res.partial).toBe(true);
    expect(res.failedEngines).toEqual([{ engine: "duckduckgo", reason: "CAPTCHA" }]);
  });

  it("does not cache empty responses", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      data: { query: "q", results: [] },
    });

    const first = await webSearch("empty uncached query", 5);
    const second = await webSearch("empty uncached query", 5);
    expect(first.results).toEqual([]);
    expect(second.cached).toBe(false);
    // An empty page 1 skips page 2, so one SearXNG call per search.
    expect(get).toHaveBeenCalledTimes(2);
  });

  describe("over-fetching two pages", () => {
    type Page = { results?: unknown[]; unresponsive_engines?: unknown } | Error;

    function mockPages(pages: Record<number, Page>) {
      return vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        const pageno = (config?.params as { pageno: number }).pageno;
        const page = pages[pageno];
        if (page instanceof Error) throw page;
        return { data: { query: "q", results: [], ...page } };
      });
    }

    const item = (n: number | string, extra: Record<string, unknown> = {}) => ({
      title: `Python ${n}`,
      url: `https://site${n}.com`,
      content: "python",
      engine: "bing",
      ...extra,
    });

    it("requests pageno 1 and 2 and merges and dedupes them", async () => {
      const get = mockPages({
        1: { results: [item(1), item(2)] },
        2: { results: [item(2, { engine: "duckduckgo" }), item(3)] },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const res = await webSearch("merge python pages", 10);

      // Page 2 brought a new URL, so pages 3 and 4 were tried (both empty).
      expect(get.mock.calls.map((c) => (c[1]?.params as { pageno: number }).pageno)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(get.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(res.results.map((r) => r.url).sort()).toEqual([
        "https://site1.com",
        "https://site2.com",
        "https://site3.com",
      ]);
      expect(res.enginesUsed).toEqual(["bing", "duckduckgo"]);
      // site2 was returned by both engines, so it ranks first.
      expect(res.results[0]?.url).toBe("https://site2.com");
      expect(res.partial).toBe(false);
    });

    it("keeps page 1 results and marks the response partial when page 2 fails", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      mockPages({ 1: { results: [item(3)] }, 2: new Error("boom") });
      const res2 = await webSearch("page two fails python", 10);
      expect(res2.results.map((r) => r.url)).toEqual(["https://site3.com"]);
      expect(res2.partial).toBe(true);
    });

    it("merges failed engines from both pages without duplicates", async () => {
      mockPages({
        1: { results: [item(1)], unresponsive_engines: [["brave", "timeout"]] },
        2: {
          results: [item(2)],
          unresponsive_engines: [
            ["brave", "timeout"],
            ["qwant", "CAPTCHA"],
          ],
        },
      });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const res = await webSearch("failed engines python", 10);
      expect(res.failedEngines).toEqual([
        { engine: "brave", reason: "timeout" },
        { engine: "qwant", reason: "CAPTCHA" },
      ]);
      expect(res.partial).toBe(true);
    });

    it("backfills low-confidence results until maxResults is reached", async () => {
      mockPages({
        1: {
          results: [
            item(1),
            item(2),
            { title: "Cooking", url: "https://cook.com", content: "recipes", engine: "bing" },
          ],
        },
        2: {
          results: [
            { title: "Gardening", url: "https://garden.com", content: "plants", engine: "bing" },
            { title: "No content", url: "https://empty.com", content: "", engine: "bing" },
          ],
        },
      });

      const res = await webSearch("backfill python", 4);

      expect(res.results).toHaveLength(4);
      expect(res.filtered).toBe(true);
      expect(res.results.slice(0, 2).every((r) => !r.lowConfidence)).toBe(true);
      expect(res.results.slice(2).every((r) => r.lowConfidence === true)).toBe(true);
      const scores = res.results.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));

      const all = await webSearch("backfill python all", 20);
      expect(all.results).toHaveLength(5);
    });

    it("does not backfill when enough good results exist", async () => {
      mockPages({
        1: {
          results: [
            item(1),
            item(2),
            { title: "Cooking", url: "https://cook.com", content: "recipes", engine: "bing" },
          ],
        },
        2: { results: [item(3)] },
      });

      const res = await webSearch("enough python", 3);
      expect(res.results.map((r) => r.url).sort()).toEqual([
        "https://site1.com",
        "https://site2.com",
        "https://site3.com",
      ]);
      expect(res.results.some((r) => r.lowConfidence)).toBe(false);
    });

    it("slices only after ranking, so a good page-2 result beats page-1 junk", async () => {
      mockPages({
        1: {
          results: [
            { title: "Cooking", url: "https://cook.com", content: "recipes", engine: "bing" },
            { title: "Gardening", url: "https://garden.com", content: "plants", engine: "bing" },
          ],
        },
        2: { results: [item("late")] },
      });

      const res = await webSearch("slice after ranking python", 1);
      expect(res.results.map((r) => r.url)).toEqual(["https://sitelate.com"]);
    });

    it("never caches empty or failed responses", async () => {
      const get = mockPages({ 1: { results: [] }, 2: { results: [] } });
      await webSearch("nothing here at all", 10);
      await webSearch("nothing here at all", 10);
      expect(get).toHaveBeenCalledTimes(2);

      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const failing = mockPages({ 1: new Error("down"), 2: { results: [] } });
      await expect(webSearch("failed search python", 10)).rejects.toThrow();
      await expect(webSearch("failed search python", 10)).rejects.toThrow();
      expect(failing).toHaveBeenCalledTimes(4);
    });

    it("includes language but not maxResults in the cache key", async () => {
      const get = mockPages({ 1: { results: [item(1)] }, 2: { results: [] } });
      await webSearch("keyed python", 10);
      await webSearch("keyed python", 10, { language: "en-GB" });
      expect(get).toHaveBeenCalledTimes(4);
      const smaller = await webSearch("keyed python", 5);
      expect(smaller.cached).toBe(true);
      const again = await webSearch(" Keyed  PYTHON", 10);
      expect(again.cached).toBe(true);
      expect(get).toHaveBeenCalledTimes(4);
    });
  });

  it("filters out malformed items missing valid url", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: {
        query: "malformed",
        results: [
          { title: "Valid", url: "https://valid.com", content: "malformed snippet" },
          { title: "No URL", url: "" },
          { title: "Null Result" },
        ],
      },
    });

    const res = await webSearch("query with malformed items", 5);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.url).toBe("https://valid.com");
  });

  it("does not drop empty-content results for non-English searches", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({
      data: { query: "d", results: [{ title: "Питон", url: "https://ru.example" }] },
    });

    const res = await webSearch("питон", 5, { language: "ru-RU" });
    expect(res.results).toHaveLength(1);
  });

  describe("20 results and the shared result pool", () => {
    type Page = { results?: unknown[]; unresponsive_engines?: unknown } | Error;

    function mockPages(pages: Record<number, Page>) {
      return vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        const pageno = (config?.params as { pageno: number }).pageno;
        const page = pages[pageno];
        if (page instanceof Error) throw page;
        return { data: { query: "q", results: [], ...page } };
      });
    }

    const items = (prefix: string, count: number, engine = "bing") =>
      Array.from({ length: count }, (_, i) => ({
        title: `Python ${prefix}${i}`,
        url: `https://${prefix}${i}.example.com`,
        content: "python guide",
        engine,
      }));

    const pagenos = (get: ReturnType<typeof mockPages>) =>
      get.mock.calls.map((c) => (c[1]?.params as { pageno: number }).pageno);

    it("returns 20 results by default from page 1 alone", async () => {
      const get = mockPages({ 1: { results: items("a", 25) }, 2: { results: items("b", 10) } });

      const res = await webSearch("twenty python");
      expect(res.results).toHaveLength(20);
      expect(res.results.every((r) => !r.lowConfidence)).toBe(true);
      expect(pagenos(get)).toEqual([1]);
    });

    it("fetches page 2 with its own shorter deadline when page 1 is short", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      const get = mockPages({ 1: { results: items("a", 12) }, 2: { results: items("b", 12) } });

      const res = await webSearch("short page python", 20);
      expect(pagenos(get)).toEqual([1, 2]);
      expect(res.results).toHaveLength(20);
      expect(res.partial).toBe(false);

      const page1Config = get.mock.calls[0]?.[1];
      const page2Config = get.mock.calls[1]?.[1];
      // SearXNG gets timeout_limit; our deadline adds a margin on top of it.
      expect(page1Config?.params).toMatchObject({ timeout_limit: 1.5 });
      expect(page2Config?.params).toMatchObject({ timeout_limit: 1 });
      expect(timeoutSpy.mock.calls).toEqual([[2250], [1750]]);
      expect(page2Config?.signal).toBeInstanceOf(AbortSignal);
      expect(page2Config?.signal).not.toBe(page1Config?.signal);
    });

    it("returns page 1 results when page 2 fails", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const get = mockPages({ 1: { results: items("a", 12) }, 2: new Error("page 2 timeout") });

      const res = await webSearch("page two down python", 20);
      expect(pagenos(get)).toEqual([1, 2]);
      expect(res.results).toHaveLength(12);
      expect(res.partial).toBe(true);
    });

    it("backfills low-confidence results before returning fewer than maxResults", async () => {
      const junk = Array.from({ length: 8 }, (_, i) => ({
        title: `Cooking ${i}`,
        url: `https://cook${i}.example.com`,
        content: "recipes",
        engine: "bing",
      }));
      mockPages({ 1: { results: [...items("a", 10), ...junk] }, 2: { results: items("b", 5) } });

      const res = await webSearch("backfill twenty python", 20);
      expect(res.results).toHaveLength(20);
      expect(res.results.slice(0, 15).every((r) => !r.lowConfidence)).toBe(true);
      expect(res.results.slice(15).every((r) => r.lowConfidence === true)).toBe(true);
    });

    it("serves maxResults 5 and 20 from one cache entry, sliced from the ranked pool", async () => {
      const get = mockPages({ 1: { results: items("a", 25) }, 2: { results: [] } });

      const twenty = await webSearch("shared pool python", 20);
      const five = await webSearch("shared pool python", 5);
      expect(five.cached).toBe(true);
      expect(five.results).toEqual(twenty.results.slice(0, 5));
      expect(get).toHaveBeenCalledTimes(1);

      const smallFirst = await webSearch("shared pool reversed python", 5);
      const bigLater = await webSearch("shared pool reversed python", 20);
      expect(smallFirst.results).toHaveLength(5);
      expect(bigLater.cached).toBe(true);
      expect(bigLater.results).toHaveLength(20);
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("slices to maxResults only after ranking across both pages", async () => {
      // shared0 is last on page 2 for bing but also on page 1 for brave, so
      // fusion ranks it first; a slice before ranking would cut it off.
      mockPages({
        1: { results: [...items("a", 3), ...items("shared", 1, "brave")] },
        2: { results: [...items("b", 3), ...items("shared", 1)] },
      });

      const res = await webSearch("ranked slice python", 5);
      expect(res.results).toHaveLength(5);
      expect(res.results[0]?.url).toBe("https://shared0.example.com");
      const scores = res.results.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((x, y) => y - x));
    });

    it("evicts the least recently used entry when the cache is full", async () => {
      configureSearchCache({ maxEntries: 2 });
      const get = mockPages({ 1: { results: items("a", 20) } });

      await webSearch("lru one python");
      await webSearch("lru two python");
      await webSearch("lru one python"); // one is now the most recently used
      await webSearch("lru three python"); // evicts two
      expect(get).toHaveBeenCalledTimes(3);

      expect((await webSearch("lru one python")).cached).toBe(true);
      expect((await webSearch("lru two python")).cached).toBe(false);
      expect(get).toHaveBeenCalledTimes(4);
    });

    it("coalesces concurrent identical searches into one SearXNG request", async () => {
      const get = mockPages({ 1: { results: items("a", 20) } });

      const [a, b, c] = await Promise.all([
        webSearch("coalesced python", 20),
        webSearch("Coalesced Python", 5),
        webSearch("coalesced python", 10),
      ]);
      expect(get).toHaveBeenCalledTimes(1);
      expect(a.results).toHaveLength(20);
      expect(b.results).toHaveLength(5);
      expect(c.results).toHaveLength(10);
    });

    it("serves a stale entry and refreshes it in the background", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      configureSearchCache({ ttlMs: 1000 });
      const get = mockPages({ 1: { results: items("a", 20) } });

      await webSearch("stale python");
      // Past the TTL, inside the stale window (also 1000ms).
      vi.setSystemTime(Date.now() + 1500);

      const stale = await webSearch("stale python");
      expect(stale.cached).toBe(true);
      expect(stale.results).toHaveLength(20);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      vi.useRealTimers();
    });
  });

  describe("controlled paging and SearXNG load", () => {
    type Page = { results?: unknown[]; unresponsive_engines?: unknown } | Error;

    const pagenoOf = (config: unknown) => (config as { params: { pageno: number } }).params.pageno;
    const calledPages = (get: { mock: { calls: unknown[][] } }) =>
      get.mock.calls.map((c) => pagenoOf(c[1]));

    // One result on python.org and three elsewhere per page, so with
    // includeDomains: ["python.org"] every page adds exactly one good result.
    const domainPage = (p: number) => ({
      results: [
        {
          title: `Python ${p}`,
          url: `https://p${p}.python.org`,
          content: "python",
          engine: "bing",
        },
        ...[1, 2, 3].map((i) => ({
          title: `Python other ${p}-${i}`,
          url: `https://other${p}-${i}.example.com`,
          content: "python",
          engine: "bing",
        })),
      ],
    });
    const sparse = { includeDomains: ["python.org"] };

    const manyResults = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        title: `Python ${i}`,
        url: `https://r${i}.example.com`,
        content: "python",
        engine: "bing",
      }));

    function mockPages(pageFor: (page: number) => Page | Promise<Page>) {
      return vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        const page = await pageFor(pagenoOf(config));
        if (page instanceof Error) throw page;
        return { data: { query: "q", results: [], ...page } };
      });
    }

    // Makes AbortSignal.timeout(ms) return an already timed-out signal when
    // `shouldTimeOut(ms)` is true; axios is mocked to honor the signal.
    function mockTimeouts(shouldTimeOut: (ms: number) => boolean) {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        shouldTimeOut(ms)
          ? AbortSignal.abort(new DOMException("timed out", "TimeoutError"))
          : realTimeout(ms),
      );
    }

    async function tracked<T>(state: { inFlight: number; peak: number }, value: T): Promise<T> {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.inFlight--;
      return value;
    }

    it("pages through all 20 SearXNG requests when good results are sparse", async () => {
      const get = mockPages((p) => domainPage(p));

      const res = await webSearch("sparse python", 20, sparse);
      // Each page is requested exactly once, in order.
      expect(calledPages(get)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(res.results).toHaveLength(20);
      expect(res.results.every((r) => r.url.endsWith(".python.org"))).toBe(true);
      expect(res.partial).toBe(false);
      expect(res.failedPages).toEqual([]);
    });

    it("never fetches more than maxPages", async () => {
      const get = mockPages((p) => domainPage(p));

      const res = await webSearch("capped python", 20, { ...sparse, maxPages: 5 });
      expect(calledPages(get)).toEqual([1, 2, 3, 4, 5]);
      expect(res.results).toHaveLength(5);
    });

    it("stops after the page 2 probe when it brings no new URLs", async () => {
      const get = mockPages(() => domainPage(1));

      const res = await webSearch("no new urls python", 20, sparse);
      expect(calledPages(get)).toEqual([1, 2]);
      expect(res.results).toHaveLength(1);
    });

    it("fetches at most two pages of one search at a time", async () => {
      const state = { inFlight: 0, peak: 0 };
      mockPages((p) => tracked(state, domainPage(p)));

      const res = await webSearch("concurrent pages python", 20, sparse);
      expect(res.results).toHaveLength(20);
      expect(state.peak).toBe(2);
    });

    it("sends eagerPages together with page 1 when maxResults needs more than one page", async () => {
      const state = { inFlight: 0, peak: 0 };
      const get = mockPages((p) => tracked(state, domainPage(p)));

      const res = await webSearch("eager pages python", 20, { ...sparse, eagerPages: 2 });
      expect(calledPages(get).slice(0, 3)).toEqual([1, 2, 3]);
      // Pages 1-3 are in flight at once; later batches stay at PAGE_CONCURRENCY.
      expect(state.peak).toBe(3);
      expect(res.results).toHaveLength(20);
    });

    it("stops a sparse search after the eager batch when the paging budget is spent", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const get = mockPages((p) => {
        // Each page takes 800ms: the eager batch ends at 0.8s, and another
        // 1.75s round would finish past the 2.5s paging budget.
        if (p === 1) vi.setSystemTime(Date.now() + 800);
        return domainPage(p);
      });

      const res = await webSearch("budget sparse python", 20, {
        ...sparse,
        eagerPages: 2,
        pagingBudgetMs: 2500,
      });
      expect(calledPages(get)).toEqual([1, 2, 3]);
      expect(res.results).toHaveLength(3);
      expect(res.partial).toBe(false);
    });

    it("sends no eager pages when page 1 can hold maxResults", async () => {
      const get = mockPages(() => ({ results: manyResults(20) }));

      const res = await webSearch("eager small python", 10, { eagerPages: 2 });
      expect(calledPages(get)).toEqual([1]);
      expect(res.results).toHaveLength(10);
    });

    it("caps SearXNG requests in flight across concurrent searches", async () => {
      configureSearxngClient({ maxConcurrentRequests: 3 });
      const state = { inFlight: 0, peak: 0 };
      const get = mockPages((p) => tracked(state, domainPage(p)));

      const all = await Promise.all(
        ["alpha", "beta", "gamma", "delta"].map((w) => webSearch(`${w} python`, 6, sparse)),
      );
      expect(state.peak).toBe(3);
      expect(all.every((r) => r.results.length === 6)).toBe(true);
      // 6 pages per search: 1, then 2, then 3+4, then 5+6.
      expect(get).toHaveBeenCalledTimes(24);
    });

    it("keeps going past a failed page, never retries it and reports it", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const get = mockPages((p) => (p === 4 ? new Error("socket hang up") : domainPage(p)));

      const res = await webSearch("one page fails python", 6, sparse);
      expect(calledPages(get)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(res.results).toHaveLength(6);
      expect(res.results.map((r) => r.url)).not.toContain("https://p4.python.org");
      expect(res.failedPages).toEqual([{ page: 4, reason: "network" }]);
      expect(res.partial).toBe(true);
    });

    it("stops paging when every page of a batch fails", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const get = mockPages((p) => (p >= 3 ? new Error("down") : domainPage(p)));

      const res = await webSearch("batch fails python", 20, sparse);
      expect(calledPages(get)).toEqual([1, 2, 3, 4]);
      expect(res.results).toHaveLength(2);
      expect(res.failedPages).toEqual([
        { page: 3, reason: "network" },
        { page: 4, reason: "network" },
      ]);
      expect(res.partial).toBe(true);
    });

    it("records a timed-out page without failing the search", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      mockTimeouts((ms) => ms === OPTIONAL_PAGE_DEADLINE_MS);
      vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        if (config?.signal?.aborted) throw new axios.CanceledError("canceled");
        return { data: { query: "q", results: domainPage(pagenoOf(config)).results } };
      });

      const res = await webSearch("timed out page python", 20, sparse);
      expect(res.results).toHaveLength(1);
      expect(res.failedPages).toEqual([{ page: 2, reason: "timeout" }]);
      expect(res.partial).toBe(true);
    });

    it("retries a timed-out page 1 once and returns a complete response", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      let page1Deadlines = 0;
      mockTimeouts((ms) => ms === PAGE_DEADLINE_MS && page1Deadlines++ === 0);
      const get = vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        if (config?.signal?.aborted) throw new axios.CanceledError("canceled");
        return { data: { query: "q", results: manyResults(20) } };
      });

      const res = await webSearch("page one timeout python");
      expect(calledPages(get)).toEqual([1, 1]);
      expect(res.results).toHaveLength(20);
      expect(res.partial).toBe(false);
      expect(res.failedPages).toEqual([]);
    });

    it("returns 502 only when page 1 times out on both attempts", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      mockTimeouts(() => true);
      const get = vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        if (config?.signal?.aborted) throw new axios.CanceledError("canceled");
        return { data: { query: "q", results: manyResults(20) } };
      });

      const err = await webSearch("always timing out python").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
        message: "SearXNG request failed after retry: canceled",
      });
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("treats a canceled request like any other page failure", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      let page1Calls = 0;
      const get = vi.spyOn(axios, "get").mockImplementation(async (_url, config) => {
        const p = pagenoOf(config);
        if ((p === 1 && page1Calls++ === 0) || p === 2) throw new axios.CanceledError("canceled");
        return { data: { query: "q", results: domainPage(p).results } };
      });

      const res = await webSearch("canceled python", 20, sparse);
      expect(calledPages(get)).toEqual([1, 1, 2]);
      expect(res.results).toHaveLength(1);
      expect(res.failedPages).toEqual([{ page: 2, reason: "canceled" }]);
      expect(res.partial).toBe(true);
    });

    it("does not retry page 1 when SearXNG rejects the request (4xx)", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const rejected = new axios.AxiosError(
        "Request failed with status code 403",
        "ERR_BAD_REQUEST",
        undefined,
        undefined,
        { status: 403 } as never,
      );
      const get = vi.spyOn(axios, "get").mockRejectedValue(rejected);

      const err = await webSearch("forbidden python").catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "SEARXNG_UNAVAILABLE",
        statusCode: 502,
        message: "SearXNG request failed: Request failed with status code 403",
      });
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("does not retry page 1 when the retry cannot finish inside the search budget", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      vi.useFakeTimers({ toFake: ["Date"] });
      const get = vi.spyOn(axios, "get").mockImplementation(async () => {
        vi.setSystemTime(Date.now() + SEARCH_BUDGET_MS - PAGE_DEADLINE_MS + 1);
        throw new Error("socket hang up");
      });

      await expect(webSearch("slow failure python")).rejects.toThrow(
        "SearXNG request failed: socket hang up",
      );
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("skips optional pages the search budget cannot fit", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const get = mockPages((p) => {
        if (p === 1) vi.setSystemTime(Date.now() + SEARCH_BUDGET_MS - OPTIONAL_PAGE_DEADLINE_MS + 1);
        return domainPage(p);
      });

      const res = await webSearch("slow page one python", 20, sparse);
      expect(calledPages(get)).toEqual([1]);
      expect(res.results).toHaveLength(1);
      expect(res.partial).toBe(false);
    });

    it("shares one paging run between concurrent identical searches", async () => {
      const state = { inFlight: 0, peak: 0 };
      const get = mockPages((p) => tracked(state, domainPage(p)));

      const [a, b] = await Promise.all([
        webSearch("shared paging python", 6, sparse),
        webSearch("Shared  Paging Python", 6, { includeDomains: ["PYTHON.org"] }),
      ]);
      expect(calledPages(get)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(a.results).toEqual(b.results);
    });

    it("caches a response with failed pages briefly, keeping failedPages", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const get = mockPages((p) => (p === 2 ? new Error("down") : domainPage(p)));

      await webSearch("cached failure python", 20, sparse);
      const again = await webSearch("cached failure python", 20, sparse);
      expect(again).toMatchObject({
        cached: true,
        partial: true,
        failedPages: [{ page: 2, reason: "network" }],
      });
      expect(get).toHaveBeenCalledTimes(2);

      // Past the 2-minute partial TTL the entry is stale: served, then refreshed.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1);
      const stale = await webSearch("cached failure python", 20, sparse);
      expect(stale.cached).toBe(true);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    });
  });
});
