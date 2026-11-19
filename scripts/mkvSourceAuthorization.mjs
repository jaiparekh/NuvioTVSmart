import { isIP } from "node:net";

/**
 * Explicit source allowlist for the future MKV session-creation endpoint.
 * No default allowlist: a public Nuvio installation must not become an
 * arbitrary URL fetcher. Hostnames must be exact matches, not suffixes.
 *
 * This is an initial authorization gate, NOT complete SSRF protection:
 * callers must also pin verified DNS addresses and block redirects when
 * invoking ffprobe/FFmpeg. Never expose session creation based on this alone.
 */
export function validateMkvSourceHost(sourceUrl, allowedHosts) {
  let url;
  try { url = new URL(sourceUrl); }
  catch { return { allowed: false, reason: "invalid-url" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.hash || !url.hostname || url.href.length > 4096) {
    return { allowed: false, reason: "invalid-url" };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return { allowed: false, reason: "ip-literal-disallowed" };
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || !hostname.includes(".")) {
    return { allowed: false, reason: "local-host-disallowed" };
  }
  const allowlist = new Set(
    (Array.isArray(allowedHosts) ? allowedHosts : [])
      .map((host) => String(host).trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean)
  );
  if (!allowlist.has(hostname)) return { allowed: false, reason: "host-not-allowlisted" };
  return { allowed: true, hostname };
}
