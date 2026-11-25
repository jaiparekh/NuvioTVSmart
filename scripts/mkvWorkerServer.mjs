// Private, token-authenticated worker. Never publish this port on the host.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createAuthorizedMkvSession, replaceAuthorizedMkvSession, closeHlsSession, readHlsAsset, closeAllHlsSessions } from "./mkvHlsSessions.mjs";
const token = process.env.NUVIO_MKV_WORKER_TOKEN || "";
if (token.length < 32) throw new Error("NUVIO_MKV_WORKER_TOKEN must contain at least 32 characters");
const port = Number(process.env.NUVIO_MKV_WORKER_PORT || 4180);
const host = process.env.NUVIO_MKV_WORKER_HOST || "0.0.0.0";
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const sessionRoute = new RegExp(`^/session/(${uuid})$`);
const assetRoute = new RegExp(`^/asset/(${uuid})/(index\\.m3u8|init\\.mp4|index-\\d{6}\\.m4s)$`);
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const a = Buffer.from(token), b = Buffer.from(auth);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { res.writeHead(403); res.end(); return; }
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  try {
    const asset = assetRoute.exec(pathname);
    if (asset && req.method === "GET") {
      const result = await readHlsAsset(asset[1], asset[2]);
      if (!result) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": result.contentType, "Content-Length": result.bytes.length });
      res.end(result.bytes); return;
    }
    const match = sessionRoute.exec(pathname);
    if (match && req.method === "DELETE") {
      await closeHlsSession(match[1]); res.writeHead(204); res.end(); return;
    }
    if ((pathname === "/session" && req.method === "POST") || (match && req.method === "PUT")) {
      let size = 0; const parts = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) { res.writeHead(413); res.end(); return; }
        parts.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(parts).toString("utf8")); }
      catch { res.writeHead(400); res.end(); return; }
      if (!input || typeof input !== "object" || Array.isArray(input)) { res.writeHead(400); res.end(); return; }
      let result;
      if (match) {
        if ((input.selectedAudioStreamIndex != null && (!Number.isSafeInteger(input.selectedAudioStreamIndex) || input.selectedAudioStreamIndex < 0)) ||
            !Number.isFinite(input.startSeconds) || input.startSeconds < 0 || input.startSeconds > 86400) {
          res.writeHead(400); res.end(); return;
        }
        result = await replaceAuthorizedMkvSession({ id: match[1], selectedAudioStreamIndex: input.selectedAudioStreamIndex ?? null, startSeconds: input.startSeconds });
      } else {
        if (typeof input.sourceUrl !== "string" ||
            (input.selectedAudioStreamIndex != null && (!Number.isSafeInteger(input.selectedAudioStreamIndex) || input.selectedAudioStreamIndex < 0)) ||
            (input.startSeconds != null && (!Number.isFinite(input.startSeconds) || input.startSeconds < 0 || input.startSeconds > 86400))) {
          res.writeHead(400); res.end(); return;
        }
        result = await createAuthorizedMkvSession(input);
      }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); return;
    }
    res.writeHead(404); res.end();
  } catch {
    res.writeHead(422, { "Content-Type": "application/json" }); res.end('{"error":"Worker operation failed"}');
  }
});
server.listen(port, host, () => console.log(`Private MKV worker listening on ${port}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  server.close();
  void closeAllHlsSessions().finally(() => process.exit(0));
});
