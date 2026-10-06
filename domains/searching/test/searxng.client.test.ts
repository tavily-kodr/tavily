import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AppError } from "@tavily/errors";
import { SearxngClient } from "../src/clients/searxng.client.js";

function startTestHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number; address: string };
      const url = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        url,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("SearxngClient", () => {
  it("formats the request with format=json and engines=google and parses response", async () => {
    let capturedUrl = "";

    const { url, close } = await startTestHttpServer((req, res) => {
      capturedUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          query: "google test",
          results: [
            {
              title: "Test Result",
              url: "https://example.com",
              content: "Test snippet",
              score: 1.0,
            },
          ],
        }),
      );
    });

    try {
      const client = new SearxngClient({ baseUrl: url, timeoutMs: 2000 });
      const data = await client.search("google test");

      assert(capturedUrl.includes("format=json"));
      assert(capturedUrl.includes("engines=google"));
      assert(capturedUrl.includes("q=google+test") || capturedUrl.includes("q=google%20test"));
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0]?.title, "Test Result");
    } finally {
      await close();
    }
  });

  it("throws SEARCH_PROVIDER_UNAVAILABLE on non-200 HTTP responses", async () => {
    const { url, close } = await startTestHttpServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("SearXNG Service Unavailable");
    });

    try {
      const client = new SearxngClient({ baseUrl: url, timeoutMs: 2000 });
      await assert.rejects(
        async () => client.search("fail query"),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "SEARCH_PROVIDER_UNAVAILABLE");
          assert.equal(err.statusCode, 503);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("throws SEARCH_PROVIDER_UNAVAILABLE when connection fails", async () => {
    // Port 1 is virtually guaranteed to fail connection
    const client = new SearxngClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
    await assert.rejects(
      async () => client.search("offline query"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SEARCH_PROVIDER_UNAVAILABLE");
        assert.equal(err.statusCode, 503);
        return true;
      },
    );
  });

  it("throws SEARCH_TIMEOUT when request exceeds timeout", async () => {
    const { url, close } = await startTestHttpServer((_req, res) => {
      // Delay response longer than client timeout
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      }, 500);
    });

    try {
      const client = new SearxngClient({ baseUrl: url, timeoutMs: 50 });
      await assert.rejects(
        async () => client.search("timeout query"),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "SEARCH_TIMEOUT");
          assert.equal(err.statusCode, 504);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("throws INVALID_SEARCH_RESPONSE when payload is not valid JSON", async () => {
    const { url, close } = await startTestHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>Not JSON</html>");
    });

    try {
      const client = new SearxngClient({ baseUrl: url, timeoutMs: 2000 });
      await assert.rejects(
        async () => client.search("html response query"),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "INVALID_SEARCH_RESPONSE");
          assert.equal(err.statusCode, 502);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("throws INVALID_SEARCH_RESPONSE when results field is missing or not an array", async () => {
    const { url, close } = await startTestHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" })); // missing results array
    });

    try {
      const client = new SearxngClient({ baseUrl: url, timeoutMs: 2000 });
      await assert.rejects(
        async () => client.search("missing results query"),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "INVALID_SEARCH_RESPONSE");
          assert.equal(err.statusCode, 502);
          return true;
        },
      );
    } finally {
      await close();
    }
  });
});
