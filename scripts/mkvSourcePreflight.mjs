import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validateMkvSourceHost } from "./mkvSourceAuthorization.mjs";

// IPv4-only on purpose: reject IPv6 until the media fetcher supports address
// pinning and IPv6 range classification. This module does not authorize FFmpeg.
export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c, d] = address.split(".").map(Number);
  if ([a, b, c, d].some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

/**
 * DNS preflight is defense-in-depth only, not a safe fetch authorization:
 * FFmpeg may re-resolve DNS or follow redirects to private destinations.
 * Never call FFmpeg using a URL merely because this preflight passed.
 */
export async function preflightMkvSource(sourceUrl, allowedHosts, resolve = lookup) {
  const hostCheck = validateMkvSourceHost(sourceUrl, allowedHosts);
  if (!hostCheck.allowed) return hostCheck;
  let addresses;
  try {
    addresses = await resolve(hostCheck.hostname, { all: true, verbatim: true });
  } catch {
    return { allowed: false, reason: "dns-failed" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0 ||
      addresses.some((entry) => !isPublicIpv4(entry?.address))) {
    return { allowed: false, reason: "non-public-or-ipv6-address" };
  }
  return { allowed: true, hostname: hostCheck.hostname, addresses: addresses.map((entry) => entry.address) };
}
