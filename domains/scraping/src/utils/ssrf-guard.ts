import net from "node:net";
import dns from "node:dns/promises";
import { AppError } from "@tavily/errors";
import type { DnsLookupFn, IpCheckResult } from "../types/url.types.js";

const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.intranet$/i,
  /\.home\.arpa$/i,
  /\.arpa$/i,
  /\.onion$/i,
];

/**
 * Checks whether a hostname matches known private, local, or special-use naming schemes.
 */
export function isBlockedHostname(hostname: string): { blocked: boolean; reason?: string } {
  const normalized = hostname.trim().toLowerCase();

  if (!normalized) {
    return { blocked: true, reason: "Hostname is empty" };
  }

  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        blocked: true,
        reason: `Hostname '${normalized}' matches forbidden local/internal pattern`,
      };
    }
  }

  return { blocked: false };
}

/**
 * Validates an IPv4 address string against all private, loopback, link-local,
 * multicast, benchmark, and reserved CIDR ranges.
 */
export function checkIpv4(ip: string): IpCheckResult {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) {
    return { isBlocked: true, reason: "Malformed IPv4 address", ip };
  }

  const octets = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });

  if (octets.some((o) => o === -1)) {
    return { isBlocked: true, reason: "Invalid IPv4 octet", ip };
  }

  const [a, b, c] = octets as [number, number, number, number];

  // 0.0.0.0/8 - Current network ("this" host) (RFC 1122)
  if (a === 0) {
    return { isBlocked: true, reason: "Current network address (0.0.0.0/8, RFC 1122)", ip };
  }

  // 10.0.0.0/8 - Private network (RFC 1918)
  if (a === 10) {
    return { isBlocked: true, reason: "Private network address (10.0.0.0/8, RFC 1918)", ip };
  }

  // 100.64.0.0/10 - Shared address / Carrier-Grade NAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) {
    return { isBlocked: true, reason: "Carrier-Grade NAT address (100.64.0.0/10, RFC 6598)", ip };
  }

  // 127.0.0.0/8 - Loopback (RFC 1122)
  if (a === 127) {
    return { isBlocked: true, reason: "Loopback address (127.0.0.0/8, RFC 1122)", ip };
  }

  // 169.254.0.0/16 - Link-local / Cloud metadata (RFC 3927)
  if (a === 169 && b === 254) {
    return {
      isBlocked: true,
      reason: "Link-local / Cloud metadata address (169.254.0.0/16, RFC 3927)",
      ip,
    };
  }

  // 172.16.0.0/12 - Private network (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) {
    return { isBlocked: true, reason: "Private network address (172.16.0.0/12, RFC 1918)", ip };
  }

  // 192.0.0.0/24 - IETF Protocol Assignments (RFC 6890)
  if (a === 192 && b === 0 && c === 0) {
    return {
      isBlocked: true,
      reason: "IETF protocol assignments (192.0.0.0/24, RFC 6890)",
      ip,
    };
  }

  // 192.0.2.0/24 - TEST-NET-1 documentation (RFC 5737)
  if (a === 192 && b === 0 && c === 2) {
    return { isBlocked: true, reason: "Documentation address (192.0.2.0/24, RFC 5737)", ip };
  }

  // 192.88.99.0/24 - 6to4 relay anycast (RFC 7526)
  if (a === 192 && b === 88 && c === 99) {
    return { isBlocked: true, reason: "6to4 relay anycast (192.88.99.0/24, RFC 7526)", ip };
  }

  // 192.168.0.0/16 - Private network (RFC 1918)
  if (a === 192 && b === 168) {
    return { isBlocked: true, reason: "Private network address (192.168.0.0/16, RFC 1918)", ip };
  }

  // 198.18.0.0/15 - Benchmarking (RFC 2544)
  if (a === 198 && (b === 18 || b === 19)) {
    return { isBlocked: true, reason: "Benchmark testing address (198.18.0.0/15, RFC 2544)", ip };
  }

  // 198.51.100.0/24 - TEST-NET-2 documentation (RFC 5737)
  if (a === 198 && b === 51 && c === 100) {
    return { isBlocked: true, reason: "Documentation address (198.51.100.0/24, RFC 5737)", ip };
  }

  // 203.0.113.0/24 - TEST-NET-3 documentation (RFC 5737)
  if (a === 203 && b === 0 && c === 113) {
    return { isBlocked: true, reason: "Documentation address (203.0.113.0/24, RFC 5737)", ip };
  }

  // 224.0.0.0/4 - Multicast (RFC 5771)
  if (a >= 224 && a <= 239) {
    return { isBlocked: true, reason: "Multicast address (224.0.0.0/4, RFC 5771)", ip };
  }

  // 240.0.0.0/4 - Reserved / Future use & Broadcast (RFC 1112)
  if (a >= 240) {
    return { isBlocked: true, reason: "Reserved / Broadcast address (240.0.0.0/4, RFC 1112)", ip };
  }

  return { isBlocked: false, ip };
}

/**
 * Parses an IPv6 address string into eight 16-bit numeric words.
 */
function parseIpv6Words(cleanIp: string): number[] | null {
  let ip = cleanIp.toLowerCase();

  // Handle embedded IPv4 at the end (e.g. ::ffff:192.168.1.1)
  const lastColon = ip.lastIndexOf(":");
  let embeddedIpv4Words: [number, number] | null = null;

  if (lastColon !== -1) {
    const trailingPart = ip.slice(lastColon + 1);
    if (trailingPart.includes(".")) {
      const octets = trailingPart.split(".").map(Number);
      if (octets.length === 4 && octets.every((o) => o >= 0 && o <= 255)) {
        const o0 = octets[0] ?? 0;
        const o1 = octets[1] ?? 0;
        const o2 = octets[2] ?? 0;
        const o3 = octets[3] ?? 0;
        embeddedIpv4Words = [(o0 << 8) | o1, (o2 << 8) | o3];
        ip = ip.slice(0, lastColon);
      } else {
        return null;
      }
    }
  }

  const doubleColonParts = ip.split("::");
  if (doubleColonParts.length > 2) {
    return null; // More than one '::' is invalid
  }

  const parseHexSection = (section: string): number[] | null => {
    if (!section) return [];
    const tokens = section.split(":");
    const result: number[] = [];
    for (const token of tokens) {
      if (!token) return null;
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      result.push(parseInt(token, 16));
    }
    return result;
  };

  let leftWords: number[];
  let rightWords: number[];

  if (doubleColonParts.length === 2) {
    const left = parseHexSection(doubleColonParts[0] ?? "");
    const right = parseHexSection(doubleColonParts[1] ?? "");
    if (left === null || right === null) return null;
    leftWords = left;
    rightWords = right;
  } else {
    const single = parseHexSection(doubleColonParts[0] ?? "");
    if (single === null) return null;
    leftWords = single;
    rightWords = [];
  }

  if (embeddedIpv4Words) {
    rightWords.push(...embeddedIpv4Words);
  }

  const existingCount = leftWords.length + rightWords.length;
  if (doubleColonParts.length === 2) {
    if (existingCount > 8) return null;
    const zerosNeeded = 8 - existingCount;
    return [...leftWords, ...new Array<number>(zerosNeeded).fill(0), ...rightWords];
  }

  if (existingCount !== 8) return null;
  return leftWords;
}

/**
 * Validates an IPv6 address string against loopback, unspecified, unique local (ULA),
 * link-local, multicast, documentation, 6to4, NAT64, and IPv4-mapped addresses.
 */
export function checkIpv6(rawIp: string): IpCheckResult {
  const cleanIp =
    rawIp
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  const words = parseIpv6Words(cleanIp);

  if (!words || words.length !== 8) {
    return { isBlocked: true, reason: "Malformed IPv6 address", ip: rawIp };
  }

  const [w0, w1, w2, w3, w4, w5, w6, w7] = words as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // ::/128 - Unspecified address (RFC 4291)
  if (words.every((w) => w === 0)) {
    return { isBlocked: true, reason: "IPv6 Unspecified address (::/128, RFC 4291)", ip: rawIp };
  }

  // ::1/128 - Loopback address (RFC 4291)
  if (words.slice(0, 7).every((w) => w === 0) && w7 === 1) {
    return { isBlocked: true, reason: "IPv6 Loopback address (::1/128, RFC 4291)", ip: rawIp };
  }

  // ::ffff:0:0/96 - IPv4-mapped IPv6 address (RFC 4291)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    const embeddedIpv4 = `${(w6 >> 8) & 0xff}.${w6 & 0xff}.${(w7 >> 8) & 0xff}.${w7 & 0xff}`;
    const v4Result = checkIpv4(embeddedIpv4);
    if (v4Result.isBlocked) {
      return {
        isBlocked: true,
        reason: `IPv4-mapped IPv6 blocked (${v4Result.reason})`,
        ip: rawIp,
        normalizedIp: embeddedIpv4,
      };
    }
  }

  // ::0:0/96 (excluding :: and ::1) - IPv4-compatible IPv6 address (RFC 4291, deprecated)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const embeddedIpv4 = `${(w6 >> 8) & 0xff}.${w6 & 0xff}.${(w7 >> 8) & 0xff}.${w7 & 0xff}`;
    const v4Result = checkIpv4(embeddedIpv4);
    if (v4Result.isBlocked) {
      return {
        isBlocked: true,
        reason: `IPv4-compatible IPv6 blocked (${v4Result.reason})`,
        ip: rawIp,
        normalizedIp: embeddedIpv4,
      };
    }
  }

  // 64:ff9b::/96 - Well-Known NAT64 Prefix (RFC 6052)
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const embeddedIpv4 = `${(w6 >> 8) & 0xff}.${w6 & 0xff}.${(w7 >> 8) & 0xff}.${w7 & 0xff}`;
    const v4Result = checkIpv4(embeddedIpv4);
    if (v4Result.isBlocked) {
      return {
        isBlocked: true,
        reason: `NAT64 embedded IPv4 blocked (${v4Result.reason})`,
        ip: rawIp,
        normalizedIp: embeddedIpv4,
      };
    }
  }

  // 2002::/16 - 6to4 prefix (RFC 3056, embeds IPv4 in w1 and w2)
  if (w0 === 0x2002) {
    const embeddedIpv4 = `${(w1 >> 8) & 0xff}.${w1 & 0xff}.${(w2 >> 8) & 0xff}.${w2 & 0xff}`;
    const v4Result = checkIpv4(embeddedIpv4);
    if (v4Result.isBlocked) {
      return {
        isBlocked: true,
        reason: `6to4 embedded IPv4 blocked (${v4Result.reason})`,
        ip: rawIp,
        normalizedIp: embeddedIpv4,
      };
    }
  }

  // fe80::/10 - Link-Local Unicast (RFC 4291)
  if ((w0 & 0xffc0) === 0xfe80) {
    return {
      isBlocked: true,
      reason: "IPv6 Link-Local address (fe80::/10, RFC 4291)",
      ip: rawIp,
    };
  }

  // fc00::/7 - Unique Local Address (ULA) (RFC 4193)
  if ((w0 & 0xfe00) === 0xfc00) {
    return {
      isBlocked: true,
      reason: "IPv6 Unique Local Address (fc00::/7, RFC 4193)",
      ip: rawIp,
    };
  }

  // ff00::/8 - Multicast (RFC 4291)
  if ((w0 & 0xff00) === 0xff00) {
    return {
      isBlocked: true,
      reason: "IPv6 Multicast address (ff00::/8, RFC 4291)",
      ip: rawIp,
    };
  }

  // 2001:db8::/32 - Documentation (RFC 3849)
  if (w0 === 0x2001 && w1 === 0x0db8) {
    return {
      isBlocked: true,
      reason: "IPv6 Documentation address (2001:db8::/32, RFC 3849)",
      ip: rawIp,
    };
  }

  // 0100::/64 - Discard prefix (RFC 6666)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) {
    return {
      isBlocked: true,
      reason: "IPv6 Discard-only address (0100::/64, RFC 6666)",
      ip: rawIp,
    };
  }

  // fec0::/10 - Deprecated Site-Local Unicast (RFC 3879)
  if ((w0 & 0xffc0) === 0xfec0) {
    return {
      isBlocked: true,
      reason: "IPv6 Site-Local address (fec0::/10, RFC 3879, deprecated)",
      ip: rawIp,
    };
  }

  return { isBlocked: false, ip: rawIp };
}

/**
 * Validates any IP address (IPv4 or IPv6) against private, loopback, and unsafe ranges.
 */
export function checkIpAddress(ip: string): IpCheckResult {
  const cleanIp = ip.trim().replace(/^\[|\]$/g, "");
  const ipVersion = net.isIP(cleanIp);

  if (ipVersion === 4) {
    return checkIpv4(cleanIp);
  }

  if (ipVersion === 6) {
    return checkIpv6(cleanIp);
  }

  return { isBlocked: true, reason: `Invalid IP address format: '${ip}'`, ip };
}

/**
 * Default DNS lookup using Node's native dns.promises.lookup with { all: true }.
 */
export const defaultDnsLookup: DnsLookupFn = async (hostname: string): Promise<string[]> => {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * Resolves a hostname to numeric IP addresses and strictly validates EVERY resolved address
 * against SSRF protections (unless allowPrivateNetworks is explicitly enabled).
 *
 * If ANY resolved address is private, loopback, or unsafe and allowPrivateNetworks is false,
 * an AppError with code SSRF_BLOCKED is thrown.
 *
 * Always returns an array of valid numeric IPv4 or IPv6 address strings.
 */
export async function resolveAndValidateHostname(
  hostname: string,
  dnsLookup: DnsLookupFn = defaultDnsLookup,
  options?: { allowPrivateNetworks?: boolean | undefined } | undefined,
): Promise<string[]> {
  const cleanHost = hostname.trim().replace(/^\[|\]$/g, "");
  const allowPrivate = Boolean(options?.allowPrivateNetworks);

  // If already an IP address, validate format and SSRF policy
  if (net.isIP(cleanHost)) {
    if (!allowPrivate) {
      const ipResult = checkIpAddress(cleanHost);
      if (ipResult.isBlocked) {
        throw new AppError(`Access to IP '${cleanHost}' is forbidden: ${ipResult.reason}`, {
          code: "SSRF_BLOCKED",
          statusCode: 400,
          details: { ip: cleanHost, reason: ipResult.reason },
        });
      }
    }
    return [cleanHost];
  }

  // Check forbidden hostname patterns (localhost, .local, .internal, etc.)
  if (!allowPrivate) {
    const hostCheck = isBlockedHostname(cleanHost);
    if (hostCheck.blocked) {
      throw new AppError(`Host '${cleanHost}' is forbidden: ${hostCheck.reason}`, {
        code: "SSRF_BLOCKED",
        statusCode: 400,
        details: { hostname: cleanHost, reason: hostCheck.reason },
      });
    }
  }

  let addresses: string[];
  try {
    addresses = await dnsLookup(cleanHost);
  } catch (err: unknown) {
    throw new AppError(`DNS resolution failed for host '${cleanHost}'`, {
      code: "DNS_RESOLUTION_FAILED",
      statusCode: 400,
      cause: err,
    });
  }

  if (!addresses || addresses.length === 0) {
    throw new AppError(`No DNS records found for host '${cleanHost}'`, {
      code: "DNS_RESOLUTION_FAILED",
      statusCode: 400,
      details: { hostname: cleanHost },
    });
  }

  // Deduplicate resolved addresses
  const uniqueAddresses = Array.from(new Set(addresses));

  // Validate that every resolved address is a valid numeric IP and passes SSRF checks
  for (const address of uniqueAddresses) {
    if (net.isIP(address) === 0) {
      throw new AppError(
        `DNS resolution returned invalid IP address format '${address}' for host '${cleanHost}'`,
        {
          code: "DNS_RESOLUTION_FAILED",
          statusCode: 400,
          details: { hostname: cleanHost, address },
        },
      );
    }

    if (!allowPrivate) {
      const ipResult = checkIpAddress(address);
      if (ipResult.isBlocked) {
        throw new AppError(
          `Host '${cleanHost}' resolved to forbidden address '${address}': ${ipResult.reason}`,
          {
            code: "SSRF_BLOCKED",
            statusCode: 400,
            details: {
              hostname: cleanHost,
              resolvedIp: address,
              allResolvedIps: uniqueAddresses,
              reason: ipResult.reason,
            },
          },
        );
      }
    }
  }

  return uniqueAddresses;
}
