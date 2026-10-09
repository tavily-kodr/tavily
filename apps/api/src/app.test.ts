import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@tavily/errors";
import * as searchingDomain from "@tavily/searching";
import { app } from "./app.js";

describe("API endpoints", () => {
  it("GET /health returns status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  describe("GET /search", () => {
    it("returns 400 when 'q' is missing", async () => {
      const res = await request(app).get("/search");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing required query param 'q'");
    });

    it("returns 400 when 'q' is empty whitespace", async () => {
      const res = await request(app).get("/search?q=   ");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing required query param 'q'");
    });

    it.each(["0", "21", "-1", "abc", "2.5"])(
      "returns 400 when 'max_results' is %s",
      async (value) => {
        const res = await request(app).get(`/search?q=test&max_results=${value}`);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(
          "Query param 'max_results' must be an integer between 1 and 20",
        );
      },
    );

    it("returns a Tavily-like response on valid request", async () => {
      const spy = vi.spyOn(searchingDomain, "webSearch").mockResolvedValueOnce({
        results: [
          {
            title: "Test Result",
            url: "https://example.com",
            snippet: "Sample snippet",
            engine: "bing",
            score: 1,
          },
          {
            title: "Weak",
            url: "https://weak.example.com",
            snippet: "Weak snippet",
            score: 0.2,
            lowConfidence: true,
          },
        ],
        cached: false,
        partial: true,
        failedEngines: [{ engine: "brave", reason: "timeout" }],
        failedPages: [{ page: 2, reason: "timeout" }],
        filtered: false,
        enginesUsed: ["bing", "duckduckgo"],
      });

      const res = await request(app).get("/search?q=test&max_results=7");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        query: "test",
        results: [
          { title: "Test Result", url: "https://example.com", content: "Sample snippet", score: 1 },
          {
            title: "Weak",
            url: "https://weak.example.com",
            content: "Weak snippet",
            score: 0.2,
            lowConfidence: true,
          },
        ],
        response_time: expect.any(Number),
        partial: true,
        failedEngines: [{ engine: "brave", reason: "timeout" }],
        failedPages: [{ page: 2, reason: "timeout" }],
        filtered: false,
        enginesUsed: ["bing", "duckduckgo"],
        cached: false,
      });
      expect(spy).toHaveBeenCalledWith(
        "test",
        7,
        expect.objectContaining({
          language: "en-US",
          topic: "general",
          timeRange: undefined,
          includeDomains: [],
          excludeDomains: [],
        }),
      );
    });

    it("parses domain lists, topic and time_range and passes them to the domain", async () => {
      const spy = vi.spyOn(searchingDomain, "webSearch").mockResolvedValueOnce({
        results: [],
        cached: false,
        partial: false,
        failedEngines: [],
        failedPages: [],
        filtered: true,
        enginesUsed: [],
      });

      const res = await request(app).get(
        "/search?q=test&include_domains=a.com,b.org&include_domains=c.net" +
          "&exclude_domains=bad.com&time_range=week&topic=news",
      );
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
      expect(spy).toHaveBeenCalledWith(
        "test",
        20,
        expect.objectContaining({
          includeDomains: ["a.com", "b.org", "c.net"],
          excludeDomains: ["bad.com"],
          timeRange: "week",
          topic: "news",
        }),
      );
    });

    it("gzips large JSON responses when the client accepts gzip", async () => {
      const results = Array.from({ length: 20 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example${i}.com`,
        snippet: "A reasonably long snippet so the body is worth compressing.",
        score: 1 - i / 20,
      }));
      const mock = {
        results,
        cached: true,
        partial: false,
        failedEngines: [],
        failedPages: [],
        filtered: true,
        enginesUsed: ["bing"],
      };
      vi.spyOn(searchingDomain, "webSearch").mockResolvedValue(mock);

      const gzipped = await request(app).get("/search?q=test").set("Accept-Encoding", "gzip");
      expect(gzipped.status).toBe(200);
      expect(gzipped.headers["content-encoding"]).toBe("gzip");
      expect(gzipped.headers["content-type"]).toMatch(/application\/json/);
      expect(gzipped.body.results).toHaveLength(20);

      const plain = await request(app).get("/search?q=test").set("Accept-Encoding", "identity");
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(plain.body.results).toEqual(gzipped.body.results);
    });

    it.each([
      ["language=@@"],
      ["time_range=decade"],
      ["topic=sports"],
      ["include_domains=not a domain"],
      ["exclude_domains=http://x.com"],
    ])("returns 400 for invalid %s", async (param) => {
      const res = await request(app).get(`/search?q=test&${param}`);
      expect(res.status).toBe(400);
    });

    it("returns a structured 503 with failed engines when all engines failed", async () => {
      vi.spyOn(searchingDomain, "webSearch").mockRejectedValueOnce(
        new AppError("All search engines failed; no results available", {
          code: "ALL_ENGINES_FAILED",
          statusCode: 503,
          details: { failedEngines: [{ engine: "bing", reason: "timeout" }] },
        }),
      );

      const res = await request(app).get("/search?q=down");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("ALL_ENGINES_FAILED");
      expect(res.body.details).toEqual({ failedEngines: [{ engine: "bing", reason: "timeout" }] });
    });

    it("handles AppError from domain correctly", async () => {
      vi.spyOn(searchingDomain, "webSearch").mockRejectedValueOnce(
        new AppError("Upstream search failed", {
          code: "SEARXNG_UNAVAILABLE",
          statusCode: 502,
        }),
      );

      const res = await request(app).get("/search?q=error-query");
      expect(res.status).toBe(502);
      expect(res.body.code).toBe("SEARXNG_UNAVAILABLE");
    });
  });
});
