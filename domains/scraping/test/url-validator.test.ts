import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@tavily/errors";
import {
  isValidUrlSyntax,
  canonicalizeUrl,
  validateUrlForScraping,
  revalidateRedirectUrl,
} from "../src/utils/url-validator.js";

const mockPublicDns = async () => ["93.184.216.34"];
const mockPrivateDns = async () => ["10.0.0.1"];
const mockMixedDns = async () => ["93.184.216.34", "127.0.0.1"];

describe("URL Validator - Syntax Checks", () => {
  it("accepts valid HTTP and HTTPS URLs", () => {
    assert.equal(isValidUrlSyntax("http://example.com"), true);
    assert.equal(isValidUrlSyntax("https://example.com/path?query=1#hash"), true);
    assert.equal(isValidUrlSyntax("https://sub.domain.co.uk:8080/deep/link"), true);
  });

  it("rejects non-strings, empty strings, and malformed strings", () => {
    assert.equal(isValidUrlSyntax(""), false);
    assert.equal(isValidUrlSyntax("   "), false);
    assert.equal(isValidUrlSyntax(null), false);
    assert.equal(isValidUrlSyntax(undefined), false);
    assert.equal(isValidUrlSyntax(123), false);
    assert.equal(isValidUrlSyntax("not-a-url"), false);
    assert.equal(isValidUrlSyntax("://missing-protocol"), false);
  });

  it("rejects non-HTTP protocols", () => {
    assert.equal(isValidUrlSyntax("file:///etc/passwd"), false);
    assert.equal(isValidUrlSyntax("ftp://ftp.example.com/file"), false);
    assert.equal(isValidUrlSyntax("javascript:alert(1)"), false);
    assert.equal(isValidUrlSyntax("data:text/html,<h1>test</h1>"), false);
    assert.equal(isValidUrlSyntax("ws://example.com/socket"), false);
    assert.equal(isValidUrlSyntax("gopher://example.com"), false);
  });
});

describe("URL Validator - Canonicalization", () => {
  it("lowercases protocol and hostname", () => {
    assert.equal(canonicalizeUrl("HTTP://EXAMPLE.COM/Page"), "http://example.com/Page");
  });

  it("removes default ports 80 for HTTP and 443 for HTTPS", () => {
    assert.equal(canonicalizeUrl("http://example.com:80/path"), "http://example.com/path");
    assert.equal(canonicalizeUrl("https://example.com:443/path"), "https://example.com/path");
    // Non-default ports are preserved
    assert.equal(canonicalizeUrl("http://example.com:8080/path"), "http://example.com:8080/path");
    assert.equal(canonicalizeUrl("https://example.com:8443/path"), "https://example.com:8443/path");
  });

  it("strips URL hash fragments", () => {
    assert.equal(canonicalizeUrl("https://example.com/path#section-1"), "https://example.com/path");
  });

  it("strips trailing slashes on pathname but preserves root slash", () => {
    assert.equal(canonicalizeUrl("https://example.com/docs/"), "https://example.com/docs");
    assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
  });
});

describe("URL Validator - validateUrlForScraping", () => {
  it("successfully validates a legitimate public website with mock DNS", async () => {
    const result = await validateUrlForScraping("https://example.com/docs/", {
      dnsLookup: mockPublicDns,
    });

    assert.equal(result.originalUrl, "https://example.com/docs/");
    assert.equal(result.canonicalUrl, "https://example.com/docs");
    assert.equal(result.parsedUrl.hostname, "example.com");
    assert.deepEqual(result.resolvedIps, ["93.184.216.34"]);
  });

  it("rejects empty or non-string input", async () => {
    await assert.rejects(
      async () => validateUrlForScraping(""),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("rejects non-HTTP protocols with INVALID_URL", async () => {
    await assert.rejects(
      async () => validateUrlForScraping("file:///etc/hosts"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );

    await assert.rejects(
      async () => validateUrlForScraping("ftp://ftp.debian.org/debian"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("rejects embedded credentials to prevent credential leaks and parsing confusion", async () => {
    await assert.rejects(
      async () => validateUrlForScraping("http://admin:secret@example.com/admin"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("blocks direct requests to localhost and private hostnames (SSRF)", async () => {
    await assert.rejects(
      async () => validateUrlForScraping("http://localhost:8080/search"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );

    await assert.rejects(
      async () => validateUrlForScraping("http://app.internal/api"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("blocks direct requests to private and cloud metadata IPs", async () => {
    // Loopback
    await assert.rejects(
      async () => validateUrlForScraping("http://127.0.0.1:3000/metrics"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );

    // AWS / GCP / Azure metadata
    await assert.rejects(
      async () => validateUrlForScraping("http://169.254.169.254/latest/meta-data/"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );

    // RFC 1918 Private LAN
    await assert.rejects(
      async () => validateUrlForScraping("http://192.168.1.1/admin"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );

    // IPv6 Loopback
    await assert.rejects(
      async () => validateUrlForScraping("http://[::1]:8080"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );

    // IPv4-mapped private IPv6
    await assert.rejects(
      async () => validateUrlForScraping("http://[::ffff:127.0.0.1]:8080"),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("blocks public-looking domains that resolve to private IPs via DNS", async () => {
    await assert.rejects(
      async () =>
        validateUrlForScraping("http://evil-rebind.com/exploit", {
          dnsLookup: mockPrivateDns,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("blocks multi-IP DNS where one IP is private", async () => {
    await assert.rejects(
      async () =>
        validateUrlForScraping("http://round-robin-evasion.com", {
          dnsLookup: mockMixedDns,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("resolves hostname to valid numeric IPs when allowPrivateNetworks is explicitly true", async () => {
    const result = await validateUrlForScraping("http://internal-service.local/data", {
      allowPrivateNetworks: true,
      dnsLookup: mockPrivateDns,
    });

    assert.equal(result.canonicalUrl, "http://internal-service.local/data");
    assert.deepEqual(result.resolvedIps, ["10.0.0.1"]);
  });
});

describe("URL Validator - revalidateRedirectUrl", () => {
  it("resolves and validates safe relative redirects", async () => {
    const result = await revalidateRedirectUrl("/dashboard", "https://example.com/login", {
      dnsLookup: mockPublicDns,
    });

    assert.equal(result.canonicalUrl, "https://example.com/dashboard");
  });

  it("resolves and validates safe absolute redirects", async () => {
    const result = await revalidateRedirectUrl(
      "https://cdn.example.com/assets",
      "https://example.com/home",
      {
        dnsLookup: mockPublicDns,
      },
    );

    assert.equal(result.canonicalUrl, "https://cdn.example.com/assets");
  });

  it("blocks dangerous redirect to localhost (SSRF redirect evasion)", async () => {
    await assert.rejects(
      async () =>
        revalidateRedirectUrl("http://localhost:8080/secret", "https://example.com/login", {
          dnsLookup: mockPublicDns,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("blocks dangerous redirect to AWS metadata service", async () => {
    await assert.rejects(
      async () =>
        revalidateRedirectUrl(
          "http://169.254.169.254/latest/meta-data/",
          "https://example.com/login",
          {
            dnsLookup: mockPublicDns,
          },
        ),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("blocks dangerous redirect to private IP", async () => {
    await assert.rejects(
      async () =>
        revalidateRedirectUrl("http://10.0.0.1/admin", "https://example.com/login", {
          dnsLookup: mockPublicDns,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        return true;
      },
    );
  });

  it("blocks dangerous redirect to file: or javascript: URI", async () => {
    await assert.rejects(
      async () =>
        revalidateRedirectUrl("file:///etc/shadow", "https://example.com/login", {
          dnsLookup: mockPublicDns,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "INVALID_URL");
        return true;
      },
    );
  });
});
