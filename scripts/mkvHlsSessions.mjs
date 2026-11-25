import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, stat, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildMkvHlsArguments, decideMkvAudioCompatibility } from "./mkvAudioCompatibility.mjs";
import { probeAudioCompatibility } from "./audioCompatibilityProbe.mjs";
import { createPinnedMkvGateway } from "./mkvPinnedGateway.mjs";
import { firstHlsSegmentName } from "./mkvPlaylist.mjs";

const FFMPEG = process.env.NUVIO_FFMPEG_PATH || "/opt/ffmpeg/bin/ffmpeg";
const MAX_SESSIONS = 2;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 20_000;
const sessions = new Map();
const sourceContexts = new Map();
let pendingSetups = 0;
const cleanupTimer = setInterval(() => {
  void cleanupIdleHlsSessions().catch(() => {});
}, 60_000);
cleanupTimer.unref?.();

/**
 * Server-side transcoding lifecycle. This module deliberately exposes NO HTTP
 * endpoint and performs NO source URL authorization: the caller must authorize
 * the source and enforce SSRF protection before invoking createHlsSession.
 */
export async function createHlsSession({ sourceUrl, audioStreamIndex, startSeconds = 0, gateway = null, reserved = false, transcodeAudio = true, channels = 2, videoCodec = "h264" }) {
  if (sessions.size + pendingSetups - (reserved ? 1 : 0) >= MAX_SESSIONS) throw new Error("Transcode capacity reached");
  const id = randomUUID();
  const directory = await mkdtemp(path.join(tmpdir(), "nuvio-mkv-"));
  const playlist = path.join(directory, "index.m3u8");
  let args;
  try {
    args = buildMkvHlsArguments({
      sourceUrl, audioStreamIndex, outputPlaylist: playlist, startSeconds, transcodeAudio, channels, videoCodec
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let child;
  try {
    child = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const session = { id, directory, child, gateway, lastAccess: Date.now(), closed: false, error: null, served: new Set(), contiguous: -1, suspended: false, busy: false };
  session.timer = setInterval(() => { void maintain(session).catch(() => { if (!session.closed) { session.error = "storage-controller-failed"; child.kill("SIGKILL"); } }); }, 250);
  session.timer.unref?.();
  sessions.set(id, session);
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk) => {
    // Never log signed media URLs or upstream headers.
    stderrBytes += chunk.length;
    if (stderrBytes > 128 * 1024) child.kill("SIGKILL");
  });
  child.on("error", () => { session.error = "ffmpeg-start-failed"; });
  child.on("close", (code) => {
    if (code !== 0 && !session.closed) session.error = "ffmpeg-exited";
  });
  return { id };
}

async function maintain(s) {
  if (s.closed || s.busy || s.error) return;
  s.busy = true;
  try {
    const names = await readdir(s.directory);
    let bytes = 0, latest = -1;
    for (const name of names) {
      const match = /^index-(\d{6})\.m4s$/.exec(name);
      const target = path.join(s.directory, name);
      if (match) {
        const n = Number(match[1]);
        latest = Math.max(latest, n);
        if (n < s.contiguous - 11) { await unlink(target).catch(() => {}); continue; }
      }
      bytes += (await stat(target).catch(() => null))?.size || 0;
    }
    if (s.closed) return;
    if (bytes >= 256 * 1024 * 1024) {
      s.error = "storage-limit"; s.child.kill("SIGKILL"); return;
    }
    if (s.child.exitCode !== null || s.child.signalCode !== null) return;
    const lead = latest - s.contiguous;
    if (!s.suspended && lead >= 3) { s.suspended = s.child.kill("SIGSTOP"); }
    else if (s.suspended && lead <= 1) { if (s.child.kill("SIGCONT")) s.suspended = false; }
  } finally { s.busy = false; }
}

function rollingPlaylist(raw, contiguous) {
  const lines = raw.trim().split(/\r?\n/);
  const cutoff = Math.max(0, contiguous - 9);
  const output = [];
  let first = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXTINF:")) {
      const name = lines[++i];
      const match = /^index-(\d{6})\.m4s$/.exec(name || "");
      if (!match || Number(match[1]) < cutoff) continue;
      if (first === null) first = Number(match[1]);
      output.push(line, name);
    } else if (!line.startsWith("#EXT-X-MEDIA-SEQUENCE:") && !line.startsWith("#EXT-X-PLAYLIST-TYPE:")) output.push(line);
  }
  output.splice(1, 0, "#EXT-X-MEDIA-SEQUENCE:" + (first ?? cutoff));
  return output.join("\n") + "\n";
}

export async function readHlsAsset(id, filename, { count = true } = {}) {
  const session = sessions.get(id);
  if (!session || session.closed) return null;
  if (session.error) throw new Error(session.error);
  if (!/^(index\.m3u8|init\.mp4|index-\d{6}\.m4s)$/.test(filename)) return null;
  session.lastAccess = Date.now();
  const target = path.join(session.directory, filename);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile() || info.size > 16 * 1024 * 1024) return null;
  let bytes = await readFile(target).catch(() => null);
  if (!bytes) return null;
  // FFmpeg may still be writing this segment. The playlist can reference it
  // before the filesystem write is complete; clients should retry 404s.
  if (bytes.length !== info.size) return null;
  if (filename.endsWith(".m3u8")) bytes = Buffer.from(rollingPlaylist(bytes.toString("utf8"), session.contiguous));
  const match = /^index-(\d{6})\.m4s$/.exec(filename);
  if (count && match) {
    const n = Number(match[1]);
    if (n > session.contiguous) session.served.add(n);
    while (session.served.delete(session.contiguous + 1)) session.contiguous++;
  }
  return {
    contentType: filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
    bytes
  };
}

/** Wait until FFmpeg has published a playlist referencing a complete first segment. */
export async function waitForHlsSessionReady(id, { timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessions.get(id);
    if (!session || session.closed) throw new Error("Transcode session closed");
    if (session.error) throw new Error(session.error);
    const playlist = await readHlsAsset(id, "index.m3u8");
    if (playlist) {
      const body = playlist.bytes.toString("utf8");
      const firstSegment = firstHlsSegmentName(body);
      if (firstSegment && await readHlsAsset(id, firstSegment, { count: false }) && await readHlsAsset(id, "init.mp4", { count: false })) return;
    }
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      throw new Error("FFmpeg exited before HLS was ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for first HLS segment");
}

export async function closeHlsSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  sourceContexts.delete(id);
  session.closed = true;
  clearInterval(session.timer);
  if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill("SIGKILL");
  // A killed FFmpeg process may still be writing segments. Wait for exit before deletion.
  if (session.child.exitCode === null && session.child.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => session.child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
  }
  await rm(session.directory, { recursive: true, force: true });
  await session.gateway?.close();
}

export async function cleanupIdleHlsSessions(now = Date.now()) {
  await Promise.all([...sessions.values()]
    .filter((session) => now - session.lastAccess > SESSION_IDLE_MS)
    .map((session) => closeHlsSession(session.id)));
}

export async function closeAllHlsSessions() {
  await Promise.all([...sessions.keys()].map(closeHlsSession));
}

/**
 * Internal, explicitly allowlisted session setup. No public HTTP endpoint is
 * installed: caller authentication and rate limits must be enforced first.
 * The source is only ever read through a DNS-pinned, loopback gateway.
 */
export async function createAuthorizedMkvSession({ sourceUrl, allowedHosts, selectedAudioStreamIndex = null, startSeconds = 0, forceHls = false }) {
  // Reserve capacity before asynchronous DNS and probing, otherwise concurrent
  // requests can all pass the sessions.size check and exceed the process limit.
  if (sessions.size + pendingSetups >= MAX_SESSIONS) throw new Error("Transcode capacity reached");
  pendingSetups++;
  let gateway;
  try {
    gateway = await createPinnedMkvGateway(sourceUrl, allowedHosts);
  } catch (error) {
    pendingSetups--;
    throw error;
  }
  let handedOff = false;
  try {
    const probe = await probeAudioCompatibility(gateway.url);
    if (!String(probe.container).split(",").some((name) => ["matroska", "webm"].includes(name))) {
      return { action: "unchanged", reason: "not-mkv" };
    }
    const decision = decideMkvAudioCompatibility(probe, { selectedAudioStreamIndex });
    if (decision.action !== "transcode-audio" && !(forceHls && decision.action === "direct")) return decision;
    // Hold the reservation until createHlsSession has installed its session.
    const session = await createHlsSession({
      sourceUrl: gateway.url,
      audioStreamIndex: decision.audioStreamIndex,
      startSeconds,
      gateway,
      reserved: true,
      transcodeAudio: decision.action === "transcode-audio",
      channels: probe.audio.find(t => t.index === decision.audioStreamIndex)?.channels || 2,
      videoCodec: probe.video[0]?.codec_name
    });
    handedOff = true;
    try {
      await waitForHlsSessionReady(session.id);
    } catch (error) {
      await closeHlsSession(session.id);
      throw error;
    }
    sourceContexts.set(session.id, {
      sourceUrl, allowedHosts: [],
      audioStreamIndex: decision.audioStreamIndex
    });
    return { ...decision, action: "hls-session", transcodeAudio: decision.action === "transcode-audio", ...session, startSeconds, playlistUrl: `/api/mkv-hls/${session.id}/index.m3u8`, audioTracks: probe.audio, duration: probe.duration };
  } finally {
    pendingSetups--;
    if (!handedOff) await gateway.close();
  }
}

/**
 * Replace an owned session for a different embedded audio stream or a seek.
 * The upstream URL comes exclusively from the existing server-side context;
 * callers cannot redirect a session to a new arbitrary source.
 * The old session is closed first to free its capacity and FFmpeg process.
 * This operation is not atomic: failed replacements leave the old session closed.
 */
export async function replaceAuthorizedMkvSession({ id, selectedAudioStreamIndex = null, startSeconds = 0 }) {
  const context = sourceContexts.get(id);
  if (!context) throw new Error("Unknown or expired MKV session");
  if (selectedAudioStreamIndex != null &&
      (!Number.isSafeInteger(selectedAudioStreamIndex) || selectedAudioStreamIndex < 0)) {
    throw new Error("Invalid audio stream index");
  }
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 86400) {
    throw new Error("Invalid start time");
  }
  await closeHlsSession(id);
  return createAuthorizedMkvSession({
    sourceUrl: context.sourceUrl,
    allowedHosts: context.allowedHosts,
    selectedAudioStreamIndex: selectedAudioStreamIndex ?? context.audioStreamIndex,
    startSeconds,
    forceHls: true
  });
}
