import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createSearchApp } from "../src/app.js";
import { createSearchRouter } from "../src/routes/search.routes.js";
import { SearchController } from "../src/controllers/search.controller.js";
import { SearchService } from "../src/services/search.service.js";
import { SearxngClient } from "../src/clients/searxng.client.js";
import { AppError } from "@tavily/errors";
import type { SearxngRawResponse } from "../src/types/search.types.js";

describe("Search API Endpoints", () => {
  let server: Server;
  let baseUrl: string;

  const sampleResults: SearxngRawResponse = {
    query: "apnacollege",
    results: [
      {
        title: "Apna College",
        url: "https://www.apnacollege.in/",
        content: "Learn coding easily with Apna College courses.",
        score: 0.95,
      },
      {
        title: "Apna College YouTube",
        url: "https://www.youtube.com/@ApnaCollegeOfficial",
        content: "Official YouTube Channel of Apna College.",
        score: 0.88,
      },
    ],
  };

  before(async () => {
    // Setup mock client for the API integration test
    const mockClient = {
      search: async (query: string) => {
        if (query === "provider-offline") {
          throw new AppError("Search provider is unavailable", {
            code: "SEARCH_PROVIDER_UNAVAILABLE",
            statusCode: 503,
          });
        }
        if (query === "provider-timeout") {
          throw new AppError("Search provider request timed out", {
            code: "SEARCH_TIMEOUT",
            statusCode: 504,
          });
        }
        if (query === "provider-malformed") {
          throw new AppError("Invalid search response structure received from provider", {
            code: "INVALID_SEARCH_RESPONSE",
            statusCode: 502,
          });
        }
        return sampleResults;
      },
    } as unknown as SearxngClient;

    const service = new SearchService({ client: mockClient });
    const controller = new SearchController(service);
    const router = createSearchRouter(controller);
    const app = createSearchApp(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number; address: string };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("handles GET /search?q=apnacollege with normalized results and took_ms", async () => {
    const res = await fetch(`${baseUrl}/search?q=apnacollege`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.query, "apnacollege");
    assert.equal(body.data.results.length, 2);
    assert.equal(body.data.results[0].title, "Apna College");
    assert.equal(body.data.results[0].url, "https://www.apnacollege.in/");
    assert.equal(typeof body.data.took_ms, "number");
    assert(body.data.took_ms >= 0);
  });

  it("handles POST /search with JSON body", async () => {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "apnacollege" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.query, "apnacollege");
    assert.equal(body.data.results.length, 2);
    assert(typeof body.data.took_ms === "number");
  });

  it("handles path-style GET /search/:query", async () => {
    const res = await fetch(`${baseUrl}/search/shariyans`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.query, "shariyans");
    assert(typeof body.data.took_ms === "number");
  });

  it("returns 400 INVALID_QUERY for missing query in GET", async () => {
    const res = await fetch(`${baseUrl}/search`);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_QUERY");
    assert.equal(body.error.message, "Search query is required");
  });

  it("returns 400 INVALID_QUERY for empty query in GET", async () => {
    const res = await fetch(`${baseUrl}/search?q=   `);
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_QUERY");
  });

  it("returns 400 INVALID_QUERY for empty body in POST", async () => {
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_QUERY");
  });

  it("returns 503 SEARCH_PROVIDER_UNAVAILABLE on SearXNG failure", async () => {
    const res = await fetch(`${baseUrl}/search?q=provider-offline`);
    assert.equal(res.status, 503);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "SEARCH_PROVIDER_UNAVAILABLE");
  });

  it("returns 504 SEARCH_TIMEOUT on SearXNG timeout", async () => {
    const res = await fetch(`${baseUrl}/search?q=provider-timeout`);
    assert.equal(res.status, 504);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "SEARCH_TIMEOUT");
  });

  it("returns 502 INVALID_SEARCH_RESPONSE on invalid SearXNG payload", async () => {
    const res = await fetch(`${baseUrl}/search?q=provider-malformed`);
    assert.equal(res.status, 502);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_SEARCH_RESPONSE");
  });
});
