import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  resolveAndNormalizeUrl,
  matchesPathRules,
  matchesDomainRules,
  isPrivateIpv4,
  isPrivateIpv6,
  validateSsrf,
} from "../src/url/index.js";
import { InvalidUrlError, SsrfBlockedError } from "../src/types/error.types.js";

describe("URL Utilities & Normalization", () => {
  test("normalizeUrl lowercases hostname and strips default ports", () => {
    assert.equal(normalizeUrl("HTTP://Example.COM:80/Path/"), "http://example.com/Path");
    assert.equal(normalizeUrl("https://example.com:443/"), "https://example.com/");
  });

  test("normalizeUrl strips tracking parameters and sorts queries", () => {
    const raw =
      "https://example.com/article?utm_source=twitter&b=2&utm_medium=cpc&a=1&fbclid=xyz123";
    const normalized = normalizeUrl(raw);
    assert.equal(normalized, "https://example.com/article?a=1&b=2");
  });

  test("normalizeUrl removes fragments and duplicate slashes", () => {
    assert.equal(
      normalizeUrl("https://example.com//a//b/?utm_campaign=spring#comments"),
      "https://example.com/a/b",
    );
  });

  test("normalizeUrl throws on invalid protocol or malformed input", () => {
    assert.throws(() => normalizeUrl("ftp://example.com"), InvalidUrlError);
    assert.throws(() => normalizeUrl(""), InvalidUrlError);
  });

  test("resolveAndNormalizeUrl handles relative paths and ignores non-web schemes", () => {
    const base = "https://example.com/blog/post-1";
    assert.equal(resolveAndNormalizeUrl("../about", base), "https://example.com/about");
    assert.equal(resolveAndNormalizeUrl("javascript:void(0)", base), null);
    assert.equal(resolveAndNormalizeUrl("mailto:test@example.com", base), null);
    assert.equal(resolveAndNormalizeUrl("tel:+1234567890", base), null);
    assert.equal(resolveAndNormalizeUrl("#section", base), null);
  });

  test("matchesPathRules enforces exclusion precedence over inclusion", () => {
    const select = ["/blog/*", "/articles/*"];
    const exclude = ["/blog/drafts/*", "/blog/private"];

    assert.equal(matchesPathRules("/blog/tech-news", select, exclude), true);
    assert.equal(matchesPathRules("/blog/drafts/post-1", select, exclude), false);
    assert.equal(matchesPathRules("/blog/private", select, exclude), false);
    assert.equal(matchesPathRules("/about", select, exclude), false);
    assert.equal(matchesPathRules("/about", [], exclude), true);
  });

  test("matchesDomainRules respects subdomains and exclusions", () => {
    const select = ["example.com", "*.tavily.com"];
    const exclude = ["bad.example.com", "spam.tavily.com"];

    assert.equal(matchesDomainRules("example.com", select, exclude), true);
    assert.equal(matchesDomainRules("sub.tavily.com", select, exclude), true);
    assert.equal(matchesDomainRules("bad.example.com", select, exclude), false);
    assert.equal(matchesDomainRules("spam.tavily.com", select, exclude), false);
    assert.equal(matchesDomainRules("other.org", select, exclude), false);
  });
});

describe("SSRF Defense & Private IP Subnets", () => {
  test("isPrivateIpv4 blocks loopback, RFC1918, CGNAT, and Cloud metadata", () => {
    assert.equal(isPrivateIpv4("127.0.0.1"), true);
    assert.equal(isPrivateIpv4("127.255.0.1"), true);
    assert.equal(isPrivateIpv4("10.0.0.1"), true);
    assert.equal(isPrivateIpv4("10.255.255.255"), true);
    assert.equal(isPrivateIpv4("172.16.0.1"), true);
    assert.equal(isPrivateIpv4("172.31.255.255"), true);
    assert.equal(isPrivateIpv4("192.168.1.1"), true);
    assert.equal(isPrivateIpv4("169.254.169.254"), true); // AWS/GCP metadata
    assert.equal(isPrivateIpv4("100.64.0.1"), true); // Carrier-grade NAT
    assert.equal(isPrivateIpv4("0.0.0.0"), true);
    assert.equal(isPrivateIpv4("255.255.255.255"), true);

    // Public IPs should pass
    assert.equal(isPrivateIpv4("8.8.8.8"), false);
    assert.equal(isPrivateIpv4("1.1.1.1"), false);
    assert.equal(isPrivateIpv4("142.250.190.46"), false);
  });

  test("isPrivateIpv6 blocks loopback, unique local, link-local, and IPv4-mapped", () => {
    assert.equal(isPrivateIpv6("::1"), true);
    assert.equal(isPrivateIpv6("fe80::1"), true);
    assert.equal(isPrivateIpv6("fc00::1"), true);
    assert.equal(isPrivateIpv6("fd00::1"), true);
    assert.equal(isPrivateIpv6("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIpv6("::ffff:192.168.1.1"), true);

    // Public IPv6 should pass
    assert.equal(isPrivateIpv6("2001:4860:4860::8888"), false);
  });

  test("validateSsrf throws on localhost hostnames and private IPs", async () => {
    await assert.rejects(() => validateSsrf("http://localhost:8080"), SsrfBlockedError);
    await assert.rejects(() => validateSsrf("http://127.0.0.1:3000"), SsrfBlockedError);
    await assert.rejects(
      () => validateSsrf("http://169.254.169.254/latest/meta-data/"),
      SsrfBlockedError,
    );
    await assert.rejects(() => validateSsrf("http://[::1]:8080"), SsrfBlockedError);
  });
});
