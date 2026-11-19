import { spawn } from "node:child_process";

const FFPROBE = process.env.NUVIO_FFPROBE_PATH || "/usr/bin/ffprobe";
const TIMEOUT_MS = 12000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Inspect a resolved media URL without shell interpolation.
 * Only call this with a server-validated, authorized playback source.
 * Never expose this helper directly as an unrestricted public URL endpoint.
 */
export function probeAudioCompatibility(sourceUrl, { headers = {} } = {}) {
  const parsed = new URL(sourceUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Unsupported media URL");
  }
  const headerLines = Object.entries(headers)
    .filter(([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value))
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  const args = [
    "-v", "error",
    "-show_entries", "format=format_name,duration:stream=index,codec_type,codec_name,channels,channel_layout,sample_rate:stream_tags=language,title",
    "-of", "json",
    ...(headerLines ? ["-headers", headerLines] : []),
    sourceUrl
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString().slice(0, 4096);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(new Error(`ffprobe failed (${signal || code}): ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        const streams = Array.isArray(result.streams) ? result.streams : [];
        resolve({
          container: result.format?.format_name || "",
          duration: Number(result.format?.duration) || null,
          video: streams.filter((stream) => stream.codec_type === "video"),
          audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
            index: stream.index,
            codec: stream.codec_name || "",
            channels: stream.channels || null,
            channelLayout: stream.channel_layout || "",
            sampleRate: Number(stream.sample_rate) || null,
            language: stream.tags?.language || "",
            title: stream.tags?.title || ""
          }))
        });
      } catch {
        reject(new Error("Invalid ffprobe response"));
      }
    });
  });
}
