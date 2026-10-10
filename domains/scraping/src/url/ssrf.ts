import dns from "node:dns/promises";
import net from "node:net";
import { SsrfBlockedError, InvalidUrlError } from "../types/error.types.js";

const dnsCache = new Map<
  string,
  { addresses: Array<{ address: string; family: number }>; expires: number }
>();

/**
 * Converts an IPv4 string to a 32-bit unsigned integer.
 */
function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address format: ${ip}`);
  }
  return (
    (((parts[0]! << 24) >>> 0) +
      ((parts[1]! << 16) >>> 0) +
      ((parts[2]! << 8) >>> 0) +
      (parts[3]! >>> 0)) >>>
    0
  );
}

/**
 * Checks if an unsigned 32-bit IPv4 integer falls in a CIDR range.
 */
function isInIpv4Cidr(ipNum: number, cidrBase: string, prefixLen: number): boolean {
  const baseNum = ipv4ToNumber(cidrBase);
  const mask = prefixLen === 0 ? 0 : ((0xffffffff << (32 - prefixLen)) >>> 0) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

/**
 * Evaluates whether an IPv4 address belongs to a private, loopback, or metadata subnet.
 */
export function isPrivateIpv4(ip: string): boolean {
  let ipNum: number;
  try {
    ipNum = ipv4ToNumber(ip);
  } catch {
    return true; // Malformed IPs blocked by default
  }

  // 127.0.0.0/8 (Loopback)
  if (isInIpv4Cidr(ipNum, "127.0.0.0", 8)) return true;
  // 10.0.0.0/8 (Private Class A)
  if (isInIpv4Cidr(ipNum, "10.0.0.0", 8)) return true;
  // 172.16.0.0/12 (Private Class B)
  if (isInIpv4Cidr(ipNum, "172.16.0.0", 12)) return true;
  // 192.168.0.0/16 (Private Class C)
  if (isInIpv4Cidr(ipNum, "192.168.0.0", 16)) return true;
  // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata)
  if (isInIpv4Cidr(ipNum, "169.254.0.0", 16)) return true;
  // 0.0.0.0/8 (Current network)
  if (isInIpv4Cidr(ipNum, "0.0.0.0", 8)) return true;
  // 100.64.0.0/10 (Shared address space / Carrier-Grade NAT)
  if (isInIpv4Cidr(ipNum, "100.64.0.0", 10)) return true;
  // 255.255.255.255/32 (Broadcast)
  if (ipNum === 0xffffffff) return true;

  return false;
}

/**
 * Evaluates whether an IPv6 address belongs to a private, loopback, or local subnet.
 */
export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // Loopback (::1) & Unspecified (::)
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized === "0000:0000:0000:0000:0000:0000:0000:0001"
  ) {
    return true;
  }

  // IPv4-mapped IPv6 address (::ffff:x.x.x.x or ::ffff:hex)
  if (normalized.startsWith("::ffff:") || normalized.startsWith("0:0:0:0:0:ffff:")) {
    const lastPart = normalized.split(":").pop();
    if (lastPart && lastPart.includes(".")) {
      return isPrivateIpv4(lastPart);
    }
  }

  // Link-local unicast (fe80::/10 -> fe80 to febf)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
    return true;
  }

  // Unique local address (fc00::/7 -> fc00 to fdff)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) {
    return true;
  }

  return false;
}

/**
 * Enterprise SSRF validator:
 * 1. Validates scheme (HTTP/HTTPS only)
 * 2. Blocks known local hostnames (localhost, *.localhost, etc.)
 * 3. Resolves DNS via node:dns/promises for ALL A and AAAA records
 * 4. Checks each resolved IP against private, loopback, link-local, and cloud metadata ranges
 */
export async function validateSsrf(url: string, allowLocalNetwork = false): Promise<void> {
  if (allowLocalNetwork) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidUrlError(url, "Cannot parse URL for SSRF validation");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(url, `Disallowed protocol '${parsed.protocol}'`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Static hostname checks
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "::1"
  ) {
    throw new SsrfBlockedError(url, `Host '${hostname}' is a loopback or local address`);
  }

  // If the hostname is already an explicit IP address
  const ipType = net.isIP(hostname);
  if (ipType === 4) {
    if (isPrivateIpv4(hostname)) {
      throw new SsrfBlockedError(
        url,
        `Direct IPv4 address '${hostname}' is in a private/restricted subnet`,
      );
    }
    return;
  }
  if (ipType === 6) {
    if (isPrivateIpv6(hostname)) {
      throw new SsrfBlockedError(
        url,
        `Direct IPv6 address '${hostname}' is in a private/restricted subnet`,
      );
    }
    return;
  }

  // Fast in-memory DNS cache to avoid repeated libuv threadpool lookups
  const cached = dnsCache.get(hostname);
  let addresses: Array<{ address: string; family: number }>;
  if (cached && cached.expires > Date.now()) {
    addresses = cached.addresses;
  } else {
    // Asynchronous DNS resolution for all IP records
    try {
      addresses = await dns.lookup(hostname, { all: true });
      dnsCache.set(hostname, { addresses, expires: Date.now() + 300_000 });
    } catch (err: unknown) {
      throw new InvalidUrlError(
        url,
        `DNS lookup failed for '${hostname}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!addresses || addresses.length === 0) {
    throw new InvalidUrlError(url, `No IP addresses found for '${hostname}'`);
  }

  for (const record of addresses) {
    if (record.family === 4 && isPrivateIpv4(record.address)) {
      throw new SsrfBlockedError(
        url,
        `Resolved IPv4 '${record.address}' for '${hostname}' is in a restricted/private subnet`,
      );
    }
    if (record.family === 6 && isPrivateIpv6(record.address)) {
      throw new SsrfBlockedError(
        url,
        `Resolved IPv6 '${record.address}' for '${hostname}' is in a restricted/private subnet`,
      );
    }
  }
}
