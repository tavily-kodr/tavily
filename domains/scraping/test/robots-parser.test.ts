import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RobotsPolicy } from "../src/utils/robots-parser.js";

describe("RobotsPolicy - RFC 9309 Compliance", () => {
  it("allows all paths when robots.txt is empty", () => {
    const policy = new RobotsPolicy("");
    assert.equal(policy.isAllowed("https://example.com/"), true);
    assert.equal(policy.isAllowed("https://example.com/admin"), true);
    assert.equal(policy.isAllowed("/secret"), true);
  });

  it("RobotsPolicy.allowAll() creates a permissive policy", () => {
    const policy = RobotsPolicy.allowAll();
    assert.equal(policy.isAllowed("https://example.com/any/path"), true);
    assert.equal(policy.getCrawlDelayMs(), undefined);
  });

  it("correctly evaluates basic Disallow rules", () => {
    const content = `
      User-agent: *
      Disallow: /admin
      Disallow: /private/
    `;
    const policy = new RobotsPolicy(content);

    assert.equal(policy.isAllowed("https://example.com/admin"), false);
    assert.equal(policy.isAllowed("https://example.com/admin/dashboard"), false);
    assert.equal(policy.isAllowed("https://example.com/private/data"), false);
    assert.equal(policy.isAllowed("https://example.com/public/data"), true);
    assert.equal(policy.isAllowed("https://example.com/"), true);
  });

  it("handles empty Disallow: as allow all", () => {
    const content = `
      User-agent: *
      Disallow:
    `;
    const policy = new RobotsPolicy(content);
    assert.equal(policy.isAllowed("https://example.com/any"), true);
  });

  it("implements longest-match precedence (RFC 9309 § 2.2.2)", () => {
    const content = `
      User-agent: *
      Disallow: /articles/
      Allow: /articles/public/
      Disallow: /articles/public/secret/
    `;
    const policy = new RobotsPolicy(content);

    // /articles/test -> matches /articles/ (disallowed)
    assert.equal(policy.isAllowed("https://example.com/articles/test"), false);
    // /articles/public/doc -> matches /articles/public/ (longer than /articles/, allowed)
    assert.equal(policy.isAllowed("https://example.com/articles/public/doc"), true);
    // /articles/public/secret/file -> matches /articles/public/secret/ (longest, disallowed)
    assert.equal(policy.isAllowed("https://example.com/articles/public/secret/file"), false);
  });

  it("prefers Allow over Disallow on equal path length (RFC 9309)", () => {
    const content = `
      User-agent: *
      Disallow: /page
      Allow: /page
    `;
    const policy = new RobotsPolicy(content);
    assert.equal(policy.isAllowed("https://example.com/page"), true);
  });

  it("matches specific User-agent over wildcard *", () => {
    const content = `
      User-agent: *
      Disallow: /shared-secret/

      User-agent: TavilyScraper
      Disallow: /tavily-secret/
      Allow: /shared-secret/
    `;

    // For TavilyScraper: /shared-secret/ is allowed, /tavily-secret/ is disallowed
    const tavilyPolicy = new RobotsPolicy(content, "TavilyScraper");
    assert.equal(tavilyPolicy.isAllowed("https://example.com/shared-secret/doc"), true);
    assert.equal(tavilyPolicy.isAllowed("https://example.com/tavily-secret/key"), false);

    // For OtherBot: falls back to * group (/shared-secret/ is disallowed)
    const otherPolicy = new RobotsPolicy(content, "OtherBot");
    assert.equal(otherPolicy.isAllowed("https://example.com/shared-secret/doc"), false);
    assert.equal(otherPolicy.isAllowed("https://example.com/tavily-secret/key"), true);
  });

  it("handles case-insensitivity in directives, agents, and comments", () => {
    const content = `
      # Global crawler rules
      USER-AGENT: tavilyscraper # comment
      DISALLOW: /admin
      crawl-delay: 2.5 # 2.5 seconds
    `;
    const policy = new RobotsPolicy(content, "TavilyScraper");

    assert.equal(policy.isAllowed("https://example.com/admin"), false);
    assert.equal(policy.isAllowed("https://example.com/public"), true);
    assert.equal(policy.getCrawlDelayMs(), 2500);
  });

  it("parses Crawl-delay directive into milliseconds", () => {
    const content = `
      User-agent: *
      Crawl-delay: 1.2
    `;
    const policy = new RobotsPolicy(content);
    assert.equal(policy.getCrawlDelayMs(), 1200);
  });

  it("supports URL objects as well as URL strings", () => {
    const content = `
      User-agent: *
      Disallow: /blocked
    `;
    const policy = new RobotsPolicy(content);
    assert.equal(policy.isAllowed(new URL("https://example.com/blocked/1")), false);
    assert.equal(policy.isAllowed(new URL("https://example.com/allowed/1")), true);
  });
});
