import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHlsSession, waitForHlsSessionReady, readHlsAsset, closeHlsSession } from "./mkvHlsSessions.mjs";

const FFMPEG = process.env.NUVIO_FFMPEG_PATH || "/opt/ffmpeg/bin/ffmpeg";

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    child.stderr.on("data", (part) => { errorOutput += String(part).slice(0, 2000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(errorOutput)));
  });
}

test("FFmpeg creates playable HLS assets from MKV and tears down cleanly", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nuvio-mkv-smoke-"));
  const file = path.join(directory, "sample.mkv");
  let server, id;
  try {
    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", file
    ]);
    server = http.createServer(async (req, res) => {
      const bytes = await readFile(file);
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        if (start >= bytes.length || end < start) { res.writeHead(416); res.end(); return; }
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes"
        });
        res.end(bytes.subarray(start, end + 1)); return;
      }
      res.writeHead(200, { "Content-Length": bytes.length, "Accept-Ranges": "bytes" });
      res.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sourceUrl = `http://127.0.0.1:${server.address().port}/sample.mkv`;
    const session = await createHlsSession({ sourceUrl, audioStreamIndex: 1 });
    id = session.id;
    await waitForHlsSessionReady(id, { timeoutMs: 20000 });
    const playlist = await readHlsAsset(id, "index.m3u8");
    assert.match(playlist.bytes.toString("utf8"), /#EXTM3U/);
    const segment = await readHlsAsset(id, "index-000000.ts");
    assert.ok(segment.bytes.length > 188);
    assert.equal(segment.bytes[0], 0x47, "MPEG-TS sync byte");
    await closeHlsSession(id); id = null;
    assert.equal(await readHlsAsset(session.id, "index.m3u8"), null);
  } finally {
    if (id) await closeHlsSession(id);
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
