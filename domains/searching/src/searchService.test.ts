import axios from "axios";
import { AppError } from "@tavily/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearch } from "./searchService.js";

describe("webSearch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an empty query", async () => {
    await expect(webSearch("   ")).rejects.toThrow("Query must not be empty");
  });

  it("rejects invalid maxResults", async () => {
    await expect(webSearch("valid query", 0)).rejects.toThrow(
      "numResults must be a positive number",
    );
    await expect(webSearch("valid query", -5)).rejects.toThrow(
      "numResults must be a positive number",
    );
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
    expect(get).toHaveBeenCalledTimes(4);
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

  it("reports unresponsive engines as partial and skips caching", async () => {
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

    await webSearch("partial query", 5);
    expect(get).toHaveBeenCalledTimes(4);
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
    expect(get).toHaveBeenCalledTimes(4);
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

      expect(get.mock.calls.map((c) => (c[1]?.params as { pageno: number }).pageno).sort()).toEqual(
        [1, 2],
      );
      expect(get.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(res.results.map((r) => r.url).sort()).toEqual([
        "https://site1.com",
        "https://site2.com",
        "https://site3.com",
      ]);
      expect(res.enginesUsed).toEqual(["bing", "duckduckgo"]);
      // site2 was returned by both engines, so it ranks first.
      expect(res.results[0]?.url).toBe("https://site2.com");
    });

    it("uses the other page when one page fails", async () => {
      mockPages({ 1: new Error("timeout"), 2: { results: [item(1), item(2)] } });
      vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const res = await webSearch("page one fails python", 10);
      expect(res.results).toHaveLength(2);

      mockPages({ 1: { results: [item(3)] }, 2: new Error("boom") });
      const res2 = await webSearch("page two fails python", 10);
      expect(res2.results.map((r) => r.url)).toEqual(["https://site3.com"]);
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
      expect(get).toHaveBeenCalledTimes(4);
    });

    it("includes language in the cache key", async () => {
      const get = mockPages({ 1: { results: [item(1)] }, 2: { results: [] } });
      await webSearch("keyed python", 10);
      await webSearch("keyed python", 10, { language: "en-GB" });
      await webSearch("keyed python", 5);
      expect(get).toHaveBeenCalledTimes(6);
      const again = await webSearch("keyed python", 10);
      expect(again.cached).toBe(true);
      expect(get).toHaveBeenCalledTimes(6);
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
});
