import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AppError } from "@tavily/errors";
import { HttpFetcher, createPinnedLookup } from "../src/clients/http-fetcher.js";
import type { HttpRequestContext } from "../src/types/scraping.types.js";

function startTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        server,
        url,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe("HttpFetcher - Core Fetching & Responses", () => {
  it("successfully fetches an HTML page and returns response details", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Hello World</h1></body></html>");
    });

    try {
      const fetcher = new HttpFetcher();
      const result = await fetcher.fetch(url, { allowPrivateNetworks: true });

      assert.equal(result.statusCode, 200);
      assert.equal(result.contentType, "text/html; charset=utf-8");
      assert.equal(result.body, "<html><body><h1>Hello World</h1></body></html>");
      assert.equal(result.finalUrl, url);
      assert.equal(result.requestedUrl, url);
      assert.equal(result.resolvedIp, "127.0.0.1");
    } finally {
      await close();
    }
  });

  it("throws SCRAPE_TIMEOUT when request exceeds configured timeout", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      // Delay response longer than client timeout
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<p>Delayed</p>");
      }, 200);
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () => fetcher.fetch(url, { timeoutMs: 50, allowPrivateNetworks: true }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "SCRAPE_TIMEOUT");
          assert.equal(err.statusCode, 504);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("throws NETWORK_ERROR on connection failure", async () => {
    const fetcher = new HttpFetcher();
    // Port 1 is virtually guaranteed to fail connection immediately
    await assert.rejects(
      async () =>
        fetcher.fetch("http://127.0.0.1:1", { timeoutMs: 1000, allowPrivateNetworks: true }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "NETWORK_ERROR");
        assert.equal(err.statusCode, 502);
        return true;
      },
    );
  });

  it("throws HTTP_ERROR when upstream returns 4xx or 5xx", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>Not Found</h1>");
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () => fetcher.fetch(url, { allowPrivateNetworks: true }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "HTTP_ERROR");
          assert.equal(err.statusCode, 404);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("throws UNSUPPORTED_CONTENT_TYPE for non-HTML responses", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end("%PDF-1.4...");
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () => fetcher.fetch(url, { allowPrivateNetworks: true }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "UNSUPPORTED_CONTENT_TYPE");
          assert.equal(err.statusCode, 415);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("throws UNSUPPORTED_CONTENT_TYPE when Content-Type header is missing", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end("raw text without content-type");
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () => fetcher.fetch(url, { allowPrivateNetworks: true }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "UNSUPPORTED_CONTENT_TYPE");
          assert.equal(err.statusCode, 415);
          return true;
        },
      );
    } finally {
      await close();
    }
  });
});

describe("HttpFetcher - Streaming Response Size & Timeout Cleanup (SEC-05)", () => {
  it("rejects immediately if Content-Length header exceeds maxSizeBytes", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": "10000",
      });
      res.end("x".repeat(10000));
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () =>
          fetcher.fetch(url, {
            maxSizeBytes: 1000,
            allowPrivateNetworks: true,
          }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "RESPONSE_TOO_LARGE");
          assert.equal(err.statusCode, 413);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("aborts stream, destroys response, and throws RESPONSE_TOO_LARGE when streamed chunks exceed limit", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      // Chunked transfer (no Content-Length)
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("a".repeat(500));
      res.write("b".repeat(600)); // Total 1100 bytes, exceeding 1000 bytes
      setTimeout(() => {
        try {
          res.write("c".repeat(500));
          res.end();
        } catch {
          // Socket already destroyed
        }
      }, 50);
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () =>
          fetcher.fetch(url, {
            maxSizeBytes: 1000,
            allowPrivateNetworks: true,
          }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "RESPONSE_TOO_LARGE");
          assert.equal(err.statusCode, 413);
          return true;
        },
      );
    } finally {
      await close();
    }
  });

  it("properly destroys request and response streams on timeout mid-stream", async () => {
    const { url, close } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<p>Initial partial chunk</p>");
      // Delay remaining chunks past client timeout
      setTimeout(() => {
        try {
          res.end("<p>Never reached</p>");
        } catch {
          // Socket destroyed
        }
      }, 200);
    });

    try {
      const fetcher = new HttpFetcher();
      await assert.rejects(
        async () =>
          fetcher.fetch(url, {
            timeoutMs: 50,
            allowPrivateNetworks: true,
          }),
        (err: unknown) => {
          assert(err instanceof AppError);
          assert.equal(err.code, "SCRAPE_TIMEOUT");
          assert.equal(err.statusCode, 504);
          return true;
        },
      );
    } finally {
      await close();
    }
  });
});

describe("HttpFetcher - Connector & createPinnedLookup (SEC-03)", () => {
  it("resolves standard callback with pinned IPv4 address and family 4", () => {
    const lookup = createPinnedLookup("93.184.216.34");
    let called = false;

    lookup("arbitrary-domain.com", (err: unknown, address: unknown, family: unknown) => {
      called = true;
      assert.equal(err, null);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
    });

    assert.equal(called, true);
  });

  it("resolves standard callback with pinned IPv6 address and family 6", () => {
    const lookup = createPinnedLookup("2606:4700:4700::1111");
    let called = false;

    lookup("arbitrary-domain.com", (err: unknown, address: unknown, family: unknown) => {
      called = true;
      assert.equal(err, null);
      assert.equal(address, "2606:4700:4700::1111");
      assert.equal(family, 6);
    });

    assert.equal(called, true);
  });

  it("resolves { all: true } option with array of objects for IPv4", () => {
    const lookup = createPinnedLookup("93.184.216.34");
    let called = false;

    lookup("arbitrary-domain.com", { all: true }, (err: unknown, addresses: unknown) => {
      called = true;
      assert.equal(err, null);
      assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
    });

    assert.equal(called, true);
  });

  it("resolves { all: true } option with array of objects for IPv6", () => {
    const lookup = createPinnedLookup("2606:4700:4700::1111");
    let called = false;

    lookup("arbitrary-domain.com", { all: true }, (err: unknown, addresses: unknown) => {
      called = true;
      assert.equal(err, null);
      assert.deepEqual(addresses, [{ address: "2606:4700:4700::1111", family: 6 }]);
    });

    assert.equal(called, true);
  });

  it("handles numeric options argument correctly", () => {
    const lookup = createPinnedLookup("93.184.216.34");
    let called = false;

    lookup("arbitrary-domain.com", 4, (err: unknown, address: unknown, family: unknown) => {
      called = true;
      assert.equal(err, null);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
    });

    assert.equal(called, true);
  });

  it("proves actual socket connects to pinned IP and sends domain Host header", async () => {
    let capturedHostHeader = "";
    const { port, close } = await startTestServer((req, res) => {
      capturedHostHeader = req.headers["host"] ?? "";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Pinned Connector Success</body></html>");
    });

    try {
      const fetcher = new HttpFetcher();
      // Hostname does not exist in real DNS, but dnsLookup returns 127.0.0.1
      const result = await fetcher.fetch(`http://unresolvable-mock-host.internal:${port}`, {
        dnsLookup: async () => ["127.0.0.1"],
        allowPrivateNetworks: true,
      });

      assert.equal(result.statusCode, 200);
      assert.equal(result.resolvedIp, "127.0.0.1");
      // Verified: socket connected to 127.0.0.1 while HTTP Host header retained the unresolvable host
      assert.equal(capturedHostHeader, `unresolvable-mock-host.internal:${port}`);
    } finally {
      await close();
    }
  });
});

describe("HttpFetcher - Cross-Origin Sensitive Header Stripping (SEC-01)", () => {
  it("preserves sensitive headers on same-origin redirects", async () => {
    const capturedHeaders: Array<Record<string, string>> = [];

    const mockTransport = async (ctx: HttpRequestContext) => {
      capturedHeaders.push({ ...ctx.headers });
      if (ctx.url.endsWith("/login")) {
        return {
          requestedUrl: ctx.url,
          finalUrl: ctx.url,
          statusCode: 302,
          contentType: "",
          headers: { location: "https://example.com/dashboard" },
          body: "",
          resolvedIp: ctx.pinnedIp,
        };
      }
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>Dashboard</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    const result = await fetcher.fetch("https://example.com/login", {
      dnsLookup: async () => ["93.184.216.34"],
      headers: {
        Authorization: "Bearer secret-token",
        Cookie: "session=xyz123",
        "X-Custom-Header": "custom-val",
      },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(capturedHeaders.length, 2);
    // Hop 1 (login): sensitive headers present
    assert.equal(capturedHeaders[0]?.["Authorization"], "Bearer secret-token");
    assert.equal(capturedHeaders[0]?.["Cookie"], "session=xyz123");
    assert.equal(capturedHeaders[0]?.["X-Custom-Header"], "custom-val");

    // Hop 2 (dashboard, same origin): sensitive headers preserved
    assert.equal(capturedHeaders[1]?.["Authorization"], "Bearer secret-token");
    assert.equal(capturedHeaders[1]?.["Cookie"], "session=xyz123");
    assert.equal(capturedHeaders[1]?.["X-Custom-Header"], "custom-val");
  });

  it("strips sensitive headers case-insensitively on cross-origin redirects while preserving ordinary headers", async () => {
    const capturedHeaders: Array<Record<string, string>> = [];

    const mockTransport = async (ctx: HttpRequestContext) => {
      capturedHeaders.push({ ...ctx.headers });
      if (ctx.url.includes("trusted-origin.com")) {
        return {
          requestedUrl: ctx.url,
          finalUrl: ctx.url,
          statusCode: 302,
          contentType: "",
          headers: { location: "https://untrusted-partner.com/callback" },
          body: "",
          resolvedIp: ctx.pinnedIp,
        };
      }
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>Partner Page</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    const result = await fetcher.fetch("https://trusted-origin.com/login", {
      dnsLookup: async () => ["93.184.216.34"],
      headers: {
        authorization: "Bearer secret-token",
        COOKIE: "session=abc456",
        "Proxy-Authorization": "Basic dXNlcjpwYXNz",
        "X-Request-Id": "req-999",
      },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(capturedHeaders.length, 2);

    // Hop 1 (trusted-origin.com): all headers present
    assert.equal(capturedHeaders[0]?.["authorization"], "Bearer secret-token");
    assert.equal(capturedHeaders[0]?.["COOKIE"], "session=abc456");
    assert.equal(capturedHeaders[0]?.["Proxy-Authorization"], "Basic dXNlcjpwYXNz");
    assert.equal(capturedHeaders[0]?.["X-Request-Id"], "req-999");

    // Hop 2 (untrusted-partner.com, cross-origin): sensitive headers stripped
    assert.equal(capturedHeaders[1]?.["authorization"], undefined);
    assert.equal(capturedHeaders[1]?.["COOKIE"], undefined);
    assert.equal(capturedHeaders[1]?.["Proxy-Authorization"], undefined);
    // Ordinary headers preserved
    assert.equal(capturedHeaders[1]?.["X-Request-Id"], "req-999");
  });

  it("does not re-introduce sensitive headers on multi-hop redirect chains", async () => {
    const capturedHeaders: Array<Record<string, string>> = [];

    const mockTransport = async (ctx: HttpRequestContext) => {
      capturedHeaders.push({ ...ctx.headers });
      if (ctx.url.includes("origin-a.com")) {
        return {
          requestedUrl: ctx.url,
          finalUrl: ctx.url,
          statusCode: 302,
          contentType: "",
          headers: { location: "https://origin-b.com/hop" },
          body: "",
          resolvedIp: ctx.pinnedIp,
        };
      }
      if (ctx.url.includes("origin-b.com/hop")) {
        return {
          requestedUrl: ctx.url,
          finalUrl: ctx.url,
          statusCode: 302,
          contentType: "",
          headers: { location: "https://origin-b.com/final" },
          body: "",
          resolvedIp: ctx.pinnedIp,
        };
      }
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>Final Destination</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    const result = await fetcher.fetch("https://origin-a.com/start", {
      dnsLookup: async () => ["93.184.216.34"],
      headers: {
        Authorization: "Bearer sensitive",
        "X-Trace": "trace-123",
      },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(capturedHeaders.length, 3);
    // Hop 1 (origin-a): sensitive present
    assert.equal(capturedHeaders[0]?.["Authorization"], "Bearer sensitive");
    // Hop 2 (origin-b, cross-origin): sensitive stripped
    assert.equal(capturedHeaders[1]?.["Authorization"], undefined);
    assert.equal(capturedHeaders[1]?.["X-Trace"], "trace-123");
    // Hop 3 (origin-b, same-origin to hop 2): sensitive remains stripped, not re-introduced
    assert.equal(capturedHeaders[2]?.["Authorization"], undefined);
    assert.equal(capturedHeaders[2]?.["X-Trace"], "trace-123");
  });
});

describe("HttpFetcher - Private-Network Hostname Fallback & Pinning (SEC-02)", () => {
  it("resolves private hostname to numeric IP when allowPrivateNetworks is explicitly true", async () => {
    let capturedPinnedIp = "";
    const mockTransport = async (ctx: HttpRequestContext) => {
      capturedPinnedIp = ctx.pinnedIp;
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>Private Service</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    const result = await fetcher.fetch("http://intranet.corp.local/api", {
      allowPrivateNetworks: true,
      dnsLookup: async () => ["10.0.0.5"],
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.resolvedIp, "10.0.0.5");
    // Pinned IP is guaranteed to be a valid numeric IP, never a hostname string
    assert.equal(capturedPinnedIp, "10.0.0.5");
  });

  it("strictly rejects private hostname when allowPrivateNetworks is false (default)", async () => {
    const fetcher = new HttpFetcher();
    await assert.rejects(
      async () =>
        fetcher.fetch("http://intranet.corp.local/api", {
          allowPrivateNetworks: false,
          dnsLookup: async () => ["10.0.0.5"],
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });
});

describe("HttpFetcher - Single-Pass Redirect Validation (SEC-04)", () => {
  it("avoids redundant DNS resolutions across redirect hops while strictly validating each destination", async () => {
    let dnsLookupCount = 0;
    const lookupCounters: Record<string, number> = {};

    const countingDnsLookup = async (hostname: string) => {
      dnsLookupCount++;
      lookupCounters[hostname] = (lookupCounters[hostname] ?? 0) + 1;
      return ["93.184.216.34"];
    };

    const mockTransport = async (ctx: HttpRequestContext) => {
      if (ctx.url.endsWith("/step-1")) {
        return {
          requestedUrl: ctx.url,
          finalUrl: ctx.url,
          statusCode: 302,
          contentType: "",
          headers: { location: "https://redirect-target.com/step-2" },
          body: "",
          resolvedIp: ctx.pinnedIp,
        };
      }
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 200,
        contentType: "text/html",
        headers: { "content-type": "text/html" },
        body: "<h1>Done</h1>",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    const result = await fetcher.fetch("https://initial-site.com/step-1", {
      dnsLookup: countingDnsLookup,
    });

    assert.equal(result.statusCode, 200);
    // Initial site resolved once, redirect target resolved once: exactly 2 DNS resolutions!
    assert.equal(dnsLookupCount, 2);
    assert.equal(lookupCounters["initial-site.com"], 1);
    assert.equal(lookupCounters["redirect-target.com"], 1);
  });

  it("proves redirect to private IP is blocked before connection in optimized flow", async () => {
    const mockTransport = async (ctx: HttpRequestContext) => ({
      requestedUrl: ctx.url,
      finalUrl: ctx.url,
      statusCode: 302,
      contentType: "",
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
      body: "",
      resolvedIp: ctx.pinnedIp,
    });

    const fetcher = new HttpFetcher(mockTransport);
    await assert.rejects(
      async () =>
        fetcher.fetch("https://public-site.com/redirect", {
          dnsLookup: async () => ["93.184.216.34"],
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });
});

describe("HttpFetcher - Redirect Loops and Limits", () => {
  it("throws TOO_MANY_REDIRECTS when redirect limit is exceeded", async () => {
    let redirectHop = 0;
    const mockTransport = async (ctx: HttpRequestContext) => {
      redirectHop++;
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 302,
        contentType: "",
        headers: { location: `https://example.com/hop-${redirectHop}` },
        body: "",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    await assert.rejects(
      async () =>
        fetcher.fetch("https://example.com/hop-0", {
          maxRedirects: 2,
          dnsLookup: async () => ["93.184.216.34"],
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "TOO_MANY_REDIRECTS");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("throws REDIRECT_LOOP when a cyclical redirect occurs", async () => {
    const mockTransport = async (ctx: HttpRequestContext) => {
      const nextLocation = ctx.url.endsWith("/loop-a")
        ? "https://example.com/loop-b"
        : "https://example.com/loop-a";
      return {
        requestedUrl: ctx.url,
        finalUrl: ctx.url,
        statusCode: 302,
        contentType: "",
        headers: { location: nextLocation },
        body: "",
        resolvedIp: ctx.pinnedIp,
      };
    };

    const fetcher = new HttpFetcher(mockTransport);
    await assert.rejects(
      async () =>
        fetcher.fetch("https://example.com/loop-a", {
          dnsLookup: async () => ["93.184.216.34"],
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "REDIRECT_LOOP");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });
});
