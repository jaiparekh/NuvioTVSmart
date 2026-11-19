import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildMkvHlsArguments, decideMkvAudioCompatibility } from "./mkvAudioCompatibility.mjs";
import { probeAudioCompatibility } from "./audioCompatibilityProbe.mjs";
import { createPinnedMkvGateway } from "./mkvPinnedGateway.mjs";

const FFMPEG = process.env.NUVIO_FFMPEG_PATH || "/opt/ffmpeg/bin/ffmpeg";
const MAX_SESSIONS = 2;
const SESSION_IDLE_MS = 5 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 20_000;
const sessions = new Map();
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
export async function createHlsSession({ sourceUrl, audioStreamIndex, startSeconds = 0, gateway = null, reserved = false }) {
  if (sessions.size + pendingSetups - (reserved ? 1 : 0) >= MAX_SESSIONS) throw new Error("Transcode capacity reached");
  const id = randomUUID();
  const directory = await mkdtemp(path.join(tmpdir(), "nuvio-mkv-"));
  const playlist = path.join(directory, "index.m3u8");
  let args;
  try {
    args = buildMkvHlsArguments({
      sourceUrl, audioStreamIndex, outputPlaylist: playlist, startSeconds
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
  const session = { id, directory, child, gateway, lastAccess: Date.now(), closed: false, error: null };
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

export async function readHlsAsset(id, filename) {
  const session = sessions.get(id);
  if (!session || session.closed) return null;
  if (session.error) throw new Error(session.error);
  if (!/^(index\.m3u8|index-\d{6}\.ts)$/.test(filename)) return null;
  session.lastAccess = Date.now();
  const target = path.join(session.directory, filename);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile() || info.size > 16 * 1024 * 1024) return null;
  const bytes = await readFile(target);
  // FFmpeg may still be writing this segment. The playlist can reference it
  // before the filesystem write is complete; clients should retry 404s.
  if (bytes.length !== info.size) return null;
  return {
    contentType: filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
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
      const firstSegment = body.match(/(?:^|\n)(index-\d{6}\.ts)(?:\r?\n|$)/);
      if (firstSegment && await readHlsAsset(id, firstSegment[1])) return;
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
  session.closed = true;
  if (session.child.exitCode === null && !session.child.killed) session.child.kill("SIGKILL");
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
export async function createAuthorizedMkvSession({ sourceUrl, allowedHosts, selectedAudioStreamIndex = null, startSeconds = 0 }) {
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
    if (decision.action !== "transcode-audio") return decision;
    // Hold the reservation until createHlsSession has installed its session.
    const session = await createHlsSession({
      sourceUrl: gateway.url,
      audioStreamIndex: decision.audioStreamIndex,
      startSeconds,
      gateway,
      reserved: true
    });
    handedOff = true;
    try {
      await waitForHlsSessionReady(session.id);
    } catch (error) {
      await closeHlsSession(session.id);
      throw error;
    }
    return { ...decision, ...session, playlistUrl: `/api/mkv-hls/${session.id}/index.m3u8`, audioTracks: probe.audio };
  } finally {
    pendingSetups--;
    if (!handedOff) await gateway.close();
  }
}
