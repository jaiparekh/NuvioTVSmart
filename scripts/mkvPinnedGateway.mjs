import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { preflightMkvSource } from "./mkvSourcePreflight.mjs";

// Opt-in, status-only diagnostics. Never log upstream URLs, headers, or errors.
const diagnosticEnabled = process.env.NUVIO_MKV_GATEWAY_DIAGNOSTICS === "1";
function diagnostic(category, status = null) {
  if (diagnosticEnabled) console.warn("[mkv-gateway]", category, status == null ? "" : `status=${status}`);
}

/**
 * Loopback-only, DNS-pinned media gateway for FFmpeg/ffprobe.
 * Every upstream request is revalidated and pinned to its checked address.
 * Redirects are never followed; upstream credentials and request headers
 * are not accepted. Range is forwarded to support MKV probing and seeking.
 *
 * This is a transport primitive, not a public session authorization API.
 */
export async function createPinnedMkvGateway(sourceUrl, allowedHosts) {
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("HTTPS media source required");
  const check = await preflightMkvSource(sourceUrl, allowedHosts);
  if (!check.allowed) throw new Error("Media source rejected");
  const token = randomUUID();
  const upstreamHost = check.hostname;
  const address = check.addresses[0];
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405); res.end(); return;
    }
    if (req.url !== "/" + token) {
      res.writeHead(404); res.end(); return;
    }
    const headers = { Host: url.host, Accept: "*/*", "Accept-Encoding": "identity" };
    const range = req.headers.range;
    if (typeof range === "string" && /^bytes=\d*-\d*$/.test(range)) {
      headers.Range = range;
    } else if (range != null) {
      res.writeHead(416); res.end(); return;
    }
    const upstream = https.request(url, {
      method: req.method,
      headers,
      // Keep TLS hostname validation/SNI intact while pinning the actual socket.
      servername: upstreamHost,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      timeout: 15000,
      maxHeaderSize: 16384,
      agent: false
    }, (remote) => {
      if (remote.statusCode >= 300 && remote.statusCode < 400) {
        diagnostic("upstream-redirect", remote.statusCode);
        remote.resume();
        res.writeHead(502); res.end(); return;
      }
      if (![200, 206, 416].includes(remote.statusCode)) {
        diagnostic("upstream-http-rejected", remote.statusCode);
        remote.resume();
        res.writeHead(502); res.end(); return;
      }
      const forwarded = {};
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        if (remote.headers[name] != null) forwarded[name] = remote.headers[name];
      }
      res.writeHead(remote.statusCode, forwarded);
      remote.pipe(res);
    });
    upstream.on("timeout", () => {
      diagnostic("upstream-timeout");
      upstream.destroy(new Error("Upstream timeout"));
    });
    upstream.on("error", (error) => {
      // Only emit a fixed category; raw TLS/network errors may contain source URLs.
      const code = error?.code;
      diagnostic(code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "ERR_TLS_CERT_ALTNAME_INVALID"
        ? "tls-validation-failed" : "upstream-network-error");
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    upstream.end();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const localUrl = "http://127.0.0.1:" + server.address().port + "/" + token;
  return {
    url: localUrl,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}
