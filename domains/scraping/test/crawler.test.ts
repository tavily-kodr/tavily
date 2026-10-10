import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { InMemoryFrontier, Deduplicator, RobotsManager } from "../src/core/index.js";
import { HttpFetcher } from "../src/fetcher/client.js";

describe("Crawler Core Components", () => {
  test("InMemoryFrontier enforces maxDepth and maxBreadth per level", () => {
    const frontier = new InMemoryFrontier({
      maxDepth: 2,
      maxBreadth: 2,
    });

    // Level 0
    assert.equal(
      frontier.enqueue({ url: "https://a.com", normalizedUrl: "https://a.com", depth: 0 }),
      true,
    );
    // Level 1
    assert.equal(
      frontier.enqueue({ url: "https://b.com", normalizedUrl: "https://b.com", depth: 1 }),
      true,
    );
    assert.equal(
      frontier.enqueue({ url: "https://c.com", normalizedUrl: "https://c.com", depth: 1 }),
      true,
    );
    // Third item at level 1 should be rejected (maxBreadth = 2)
    assert.equal(
      frontier.enqueue({ url: "https://d.com", normalizedUrl: "https://d.com", depth: 1 }),
      false,
    );

    // Level 3 should be rejected (maxDepth = 2)
    assert.equal(
      frontier.enqueue({ url: "https://e.com", normalizedUrl: "https://e.com", depth: 3 }),
      false,
    );

    // FIFO ordering
    const first = frontier.dequeue();
    assert.equal(first?.url, "https://a.com");
    const second = frontier.dequeue();
    assert.equal(second?.url, "https://b.com");
  });

  test("Deduplicator tracks visited URLs and content hashes", () => {
    const dedup = new Deduplicator();

    assert.equal(dedup.isUrlSeen("https://example.com"), false);
    assert.equal(dedup.markUrlSeen("https://example.com"), true);
    assert.equal(dedup.isUrlSeen("https://example.com"), true);
    assert.equal(dedup.markUrlSeen("https://example.com"), false); // already seen

    const hash = "1234567890abcdef";
    assert.equal(dedup.isContentSeen(hash), false);
    assert.equal(dedup.markContentSeen(hash), true);
    assert.equal(dedup.isContentSeen(hash), true);
    assert.equal(dedup.markContentSeen(hash), false);
  });

  test("RobotsManager permits crawling when robots.txt is missing or permissive", async () => {
    const fetcher = new HttpFetcher();
    const robots = new RobotsManager(fetcher);

    // If robots.txt returns 404/error, isAllowed should default to true (permissive)
    const allowed = await robots.isAllowed("https://nonexistent-domain-12345.com/page");
    assert.equal(allowed, true);
  });
});
