import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "@tavily/errors";
import {
  checkIpAddress,
  checkIpv4,
  checkIpv6,
  isBlockedHostname,
  resolveAndValidateHostname,
} from "../src/utils/ssrf-guard.js";

describe("SSRF Guard - IPv4 Address Checks", () => {
  it("blocks loopback addresses (127.0.0.0/8)", () => {
    assert.equal(checkIpv4("127.0.0.1").isBlocked, true);
    assert.equal(checkIpv4("127.0.1.1").isBlocked, true);
    assert.equal(checkIpv4("127.255.255.255").isBlocked, true);
  });

  it("blocks private network ranges (RFC 1918)", () => {
    // 10.0.0.0/8
    assert.equal(checkIpv4("10.0.0.1").isBlocked, true);
    assert.equal(checkIpv4("10.255.255.255").isBlocked, true);

    // 172.16.0.0/12
    assert.equal(checkIpv4("172.16.0.1").isBlocked, true);
    assert.equal(checkIpv4("172.31.255.254").isBlocked, true);
    // Non-private 172.x should not be blocked by 172.16/12 rule
    assert.equal(checkIpv4("172.15.0.1").isBlocked, false);
    assert.equal(checkIpv4("172.32.0.1").isBlocked, false);

    // 192.168.0.0/16
    assert.equal(checkIpv4("192.168.0.1").isBlocked, true);
    assert.equal(checkIpv4("192.168.254.254").isBlocked, true);
  });

  it("blocks link-local and cloud metadata addresses (169.254.0.0/16)", () => {
    // AWS / GCP / Azure metadata service
    assert.equal(checkIpv4("169.254.169.254").isBlocked, true);
    assert.equal(checkIpv4("169.254.1.1").isBlocked, true);
  });

  it("blocks current network (0.0.0.0/8)", () => {
    assert.equal(checkIpv4("0.0.0.0").isBlocked, true);
    assert.equal(checkIpv4("0.1.2.3").isBlocked, true);
  });

  it("blocks carrier-grade NAT (100.64.0.0/10)", () => {
    assert.equal(checkIpv4("100.64.0.1").isBlocked, true);
    assert.equal(checkIpv4("100.127.255.255").isBlocked, true);
    assert.equal(checkIpv4("100.63.255.255").isBlocked, false);
    assert.equal(checkIpv4("100.128.0.1").isBlocked, false);
  });

  it("blocks multicast (224.0.0.0/4) and reserved/broadcast (240.0.0.0/4)", () => {
    assert.equal(checkIpv4("224.0.0.1").isBlocked, true);
    assert.equal(checkIpv4("239.255.255.255").isBlocked, true);
    assert.equal(checkIpv4("240.0.0.1").isBlocked, true);
    assert.equal(checkIpv4("255.255.255.255").isBlocked, true);
  });

  it("blocks documentation and benchmark test ranges", () => {
    assert.equal(checkIpv4("192.0.2.1").isBlocked, true); // TEST-NET-1
    assert.equal(checkIpv4("198.51.100.1").isBlocked, true); // TEST-NET-2
    assert.equal(checkIpv4("203.0.113.1").isBlocked, true); // TEST-NET-3
    assert.equal(checkIpv4("198.18.0.1").isBlocked, true); // Benchmark
    assert.equal(checkIpv4("198.19.255.255").isBlocked, true); // Benchmark
  });

  it("allows standard public IPv4 addresses", () => {
    assert.equal(checkIpv4("93.184.216.34").isBlocked, false); // example.com
    assert.equal(checkIpv4("8.8.8.8").isBlocked, false); // Google DNS
    assert.equal(checkIpv4("1.1.1.1").isBlocked, false); // Cloudflare DNS
  });
});

describe("SSRF Guard - IPv6 Address Checks", () => {
  it("blocks IPv6 loopback (::1) and unspecified (::)", () => {
    assert.equal(checkIpv6("::1").isBlocked, true);
    assert.equal(checkIpv6("0:0:0:0:0:0:0:1").isBlocked, true);
    assert.equal(checkIpv6("::").isBlocked, true);
    assert.equal(checkIpv6("0:0:0:0:0:0:0:0").isBlocked, true);
  });

  it("blocks IPv6 link-local addresses (fe80::/10)", () => {
    assert.equal(checkIpv6("fe80::1").isBlocked, true);
    assert.equal(checkIpv6("fe80::abcd:ef01").isBlocked, true);
  });

  it("blocks IPv6 unique local addresses (fc00::/7)", () => {
    assert.equal(checkIpv6("fc00::1").isBlocked, true);
    assert.equal(checkIpv6("fd00::1").isBlocked, true);
    assert.equal(checkIpv6("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff").isBlocked, true);
  });

  it("blocks IPv6 multicast addresses (ff00::/8)", () => {
    assert.equal(checkIpv6("ff02::1").isBlocked, true);
    assert.equal(checkIpv6("ff01::1").isBlocked, true);
  });

  it("blocks IPv4-mapped IPv6 addresses targeting private/unsafe IPv4", () => {
    // ::ffff:127.0.0.1 -> Loopback
    assert.equal(checkIpv6("::ffff:127.0.0.1").isBlocked, true);
    // ::ffff:169.254.169.254 -> AWS metadata
    assert.equal(checkIpv6("::ffff:169.254.169.254").isBlocked, true);
    // ::ffff:10.0.0.1 -> Private
    assert.equal(checkIpv6("::ffff:10.0.0.1").isBlocked, true);
    // ::ffff:192.168.1.1 -> Private
    assert.equal(checkIpv6("::ffff:192.168.1.1").isBlocked, true);
  });

  it("allows IPv4-mapped IPv6 addresses targeting valid public IPv4", () => {
    assert.equal(checkIpv6("::ffff:93.184.216.34").isBlocked, false);
    assert.equal(checkIpv6("::ffff:8.8.8.8").isBlocked, false);
  });

  it("blocks 6to4 embedded private IPv4 addresses (2002::/16)", () => {
    // 2002:7f00:0001:: embeds 127.0.0.1
    assert.equal(checkIpv6("2002:7f00:0001::").isBlocked, true);
    // 2002:0a00:0001:: embeds 10.0.0.1
    assert.equal(checkIpv6("2002:0a00:0001::").isBlocked, true);
  });

  it("blocks NAT64 embedded private IPv4 addresses (64:ff9b::/96)", () => {
    assert.equal(checkIpv6("64:ff9b::127.0.0.1").isBlocked, true);
    assert.equal(checkIpv6("64:ff9b::10.0.0.1").isBlocked, true);
  });

  it("allows standard public IPv6 addresses", () => {
    assert.equal(checkIpv6("2606:4700:4700::1111").isBlocked, false); // Cloudflare DNS
    assert.equal(checkIpv6("2001:4860:4860::8888").isBlocked, false); // Google DNS
  });
});

describe("SSRF Guard - Unified checkIpAddress", () => {
  it("validates IPv4 and IPv6 strings with or without brackets", () => {
    assert.equal(checkIpAddress("127.0.0.1").isBlocked, true);
    assert.equal(checkIpAddress("[::1]").isBlocked, true);
    assert.equal(checkIpAddress("93.184.216.34").isBlocked, false);
    assert.equal(checkIpAddress("[2606:4700:4700::1111]").isBlocked, false);
  });

  it("rejects invalid IP format strings", () => {
    assert.equal(checkIpAddress("not-an-ip").isBlocked, true);
    assert.equal(checkIpAddress("999.999.999.999").isBlocked, true);
  });
});

describe("SSRF Guard - Hostname Checking", () => {
  it("blocks localhost and local naming variants", () => {
    assert.equal(isBlockedHostname("localhost").blocked, true);
    assert.equal(isBlockedHostname("LOCALHOST").blocked, true);
    assert.equal(isBlockedHostname("sub.localhost").blocked, true);
    assert.equal(isBlockedHostname("myhost.local").blocked, true);
    assert.equal(isBlockedHostname("api.internal").blocked, true);
    assert.equal(isBlockedHostname("printer.lan").blocked, true);
    assert.equal(isBlockedHostname("router.intranet").blocked, true);
    assert.equal(isBlockedHostname("hidden.onion").blocked, true);
  });

  it("allows standard public domain names", () => {
    assert.equal(isBlockedHostname("example.com").blocked, false);
    assert.equal(isBlockedHostname("api.tavily.com").blocked, false);
    assert.equal(isBlockedHostname("news.ycombinator.com").blocked, false);
  });
});

describe("SSRF Guard - DNS Resolution & Multi-Address Protection", () => {
  it("succeeds when all resolved addresses are public", async () => {
    const mockLookup = async () => ["93.184.216.34", "93.184.216.35"];
    const result = await resolveAndValidateHostname("example.com", mockLookup);

    assert.equal(result.length, 2);
    assert.deepEqual(result, ["93.184.216.34", "93.184.216.35"]);
  });

  it("rejects immediately when hostname resolves to a single private IP", async () => {
    const mockLookup = async () => ["10.0.0.5"];

    await assert.rejects(
      async () => resolveAndValidateHostname("internal-svc.company", mockLookup),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("blocks multi-address DNS when ANY resolved IP is private (anti-round-robin bypass)", async () => {
    // Attack scenario: Domain lists both a public IP and 127.0.0.1
    const mockLookup = async () => ["93.184.216.34", "127.0.0.1"];

    await assert.rejects(
      async () => resolveAndValidateHostname("mixed-dns.evil.com", mockLookup),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        assert.equal((err.details as { resolvedIp: string }).resolvedIp, "127.0.0.1");
        return true;
      },
    );
  });

  it("blocks multi-address DNS when one IP is IPv4-mapped private IPv6", async () => {
    const mockLookup = async () => ["93.184.216.34", "::ffff:169.254.169.254"];

    await assert.rejects(
      async () => resolveAndValidateHostname("metadata-evasion.evil.com", mockLookup),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "SSRF_BLOCKED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("throws DNS_RESOLUTION_FAILED when DNS resolution returns no records", async () => {
    const mockLookup = async () => [];

    await assert.rejects(
      async () => resolveAndValidateHostname("empty-records.com", mockLookup),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "DNS_RESOLUTION_FAILED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("throws DNS_RESOLUTION_FAILED when DNS resolution rejects", async () => {
    const mockLookup = async () => {
      throw new Error("ENOTFOUND nonexistent.domain");
    };

    await assert.rejects(
      async () => resolveAndValidateHostname("nonexistent.domain", mockLookup),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "DNS_RESOLUTION_FAILED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });

  it("permits resolution of private addresses when allowPrivateNetworks is explicitly true", async () => {
    const mockLookup = async () => ["10.0.0.1", "127.0.0.1"];
    const result = await resolveAndValidateHostname("internal.corp", mockLookup, {
      allowPrivateNetworks: true,
    });

    assert.deepEqual(result, ["10.0.0.1", "127.0.0.1"]);
  });

  it("throws DNS_RESOLUTION_FAILED if DNS returns non-IP strings even with allowPrivateNetworks: true", async () => {
    const mockLookup = async () => ["not-an-ip"];

    await assert.rejects(
      async () =>
        resolveAndValidateHostname("malformed-dns.com", mockLookup, {
          allowPrivateNetworks: true,
        }),
      (err: unknown) => {
        assert(err instanceof AppError);
        assert.equal(err.code, "DNS_RESOLUTION_FAILED");
        assert.equal(err.statusCode, 400);
        return true;
      },
    );
  });
});
