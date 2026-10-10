import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureServerInstance {
  server: http.Server;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Starts a deterministic local HTTP server providing representative test fixtures
 * for benchmarking the scraping and crawling pipeline.
 */
export async function startFixtureServer(): Promise<FixtureServerInstance> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // 1. Static standard article page
    if (pathname === "/static-article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Understanding Modern Search and Crawling Architecture</title>
  <meta name="description" content="An in-depth technical analysis of search, crawling, and content extraction pipelines.">
  <link rel="canonical" href="${url.origin}/static-article">
</head>
<body>
  <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
  <header><h1>Modern Search Systems</h1></header>
  <main>
    <article>
      <h2>Pipeline Architecture</h2>
      <p>Modern search engines combine query decomposition, upstream index aggregation, real-time fetching, and neural content extraction. Crawling candidate links produces rich snippets that exceed basic search provider summaries.</p>
      <p>Content extraction removes boilerplate like navigation menus, headers, and advertisement tracking scripts, preserving semantic text blocks and paragraphs for indexing.</p>
    </article>
  </main>
  <footer><p>© 2026 Tavily Benchmark Suite</p></footer>
</body>
</html>`);
      return;
    }

    // 2. JavaScript-heavy / client-rendered page
    if (pathname === "/js-rendered") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Client Rendered Single Page Application</title>
</head>
<body>
  <div id="root">Loading application state...</div>
  <script>
    document.getElementById('root').innerText = 'Dynamically injected client content';
  </script>
</body>
</html>`);
      return;
    }

    // 3. Error page (HTTP 500)
    if (pathname === "/server-error") {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>500 Internal Server Error</title></head>
<body><h1>500 Internal Server Error</h1><p>The server encountered an unexpected error.</p></body>
</html>`);
      return;
    }

    // 4. Slow / timeout page
    if (pathname === "/slow-page") {
      // Delay response for 6 seconds (exceeding typical 4s crawl timeout)
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!DOCTYPE html><html><body><p>Delayed content that took too long</p></body></html>`,
          );
        }
      }, 6000);
      return;
    }

    // 5. Redirect page (302 redirect to /static-article)
    if (pathname === "/redirect-to-article") {
      res.writeHead(302, {
        Location: "/static-article",
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(`<!DOCTYPE html><html><body><p>Redirecting to article...</p></body></html>`);
      return;
    }

    // 6. Duplicate canonicals (duplicate page pointing to /static-article)
    if (pathname === "/duplicate-alias") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Understanding Modern Search and Crawling Architecture</title>
  <link rel="canonical" href="${url.origin}/static-article">
</head>
<body>
  <p>Modern search engines combine query decomposition, upstream index aggregation, real-time fetching, and neural content extraction.</p>
</body>
</html>`);
      return;
    }

    // 7. Minimal / empty content page
    if (pathname === "/empty-page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Empty Placeholder</title></head>
<body>
  <div>   </div>
  <!-- Only comments and empty whitespace -->
</body>
</html>`);
      return;
    }

    // 8. 404 fallback
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><html><body><h1>Not Found</h1></body></html>");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
