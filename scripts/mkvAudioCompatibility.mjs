/**
 * Browser-focused MKV audio compatibility policy.
 * Decisions use probed codecs, not filename guesses or browser audioTracks.
 * The caller must separately establish that the source is a reachable MKV and
 * that the browser can decode the video codec. HEVC passthrough does not imply browser support.
 */
const DIRECT_AUDIO = new Set(["aac", "mp3"]);
const CONVERT_AUDIO = new Set(["eac3", "ac3", "dts", "truehd"]);
const COPY_VIDEO = new Set(["h264", "hevc"]);

export function normalizeAudioCodec(codec) {
  const value = String(codec || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (value === "ec3" || value === "eac3") return "eac3";
  if (value.startsWith("dts")) return "dts";
  if (value.startsWith("truehd") || value === "mlp") return "truehd";
  if (value === "ac3") return "ac3";
  if (value.startsWith("aac")) return "aac";
  if (value === "mp3") return "mp3";
  return value;
}

export function decideMkvAudioCompatibility(probe, {
  selectedAudioStreamIndex = null,
  videoSupported = true
} = {}) {
  const video = (probe?.video || [])[0];
  const audio = probe?.audio || [];
  if (!video || !audio.length) return { action: "unchanged", reason: "missing-stream-metadata" };
  if (!COPY_VIDEO.has(String(video.codec_name || video.codec || "").toLowerCase()) || !videoSupported) {
    return { action: "unchanged", reason: "video-compatibility-unconfirmed" };
  }
  const selected = selectedAudioStreamIndex == null
    ? audio[0]
    : audio.find((track) => track.index === selectedAudioStreamIndex);
  if (!selected) return { action: "unchanged", reason: "audio-stream-not-found" };
  const codec = normalizeAudioCodec(selected.codec || selected.codec_name);
  if (DIRECT_AUDIO.has(codec)) return { action: "direct", reason: "compatible-audio", audioStreamIndex: selected.index };
  if (CONVERT_AUDIO.has(codec)) {
    return { action: "transcode-audio", reason: "unsupported-audio", audioStreamIndex: selected.index, outputCodec: "aac", videoMode: "copy" };
  }
  return { action: "unchanged", reason: "unknown-audio-codec" };
}

/** Arguments only: never pass a shell command or untrusted argument string. */
export function buildMkvHlsArguments({
  sourceUrl, audioStreamIndex, outputPlaylist, startSeconds = 0,
  transcodeAudio = true, channels = 2, videoCodec = "h264"
}) {
  if (!Number.isSafeInteger(audioStreamIndex) || audioStreamIndex < 0) throw new Error("Invalid audio stream index");
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error("Invalid start time");
  let parsed;
  try { parsed = new URL(sourceUrl); } catch { throw new Error("Invalid source URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid source URL");
  if (typeof outputPlaylist !== "string" || !outputPlaylist) throw new Error("Missing output playlist");
  return [
    "-hide_banner", "-nostdin", "-loglevel", "warning", "-threads", "2", "-readrate", "1.5", "-readrate_initial_burst", "10",
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i", sourceUrl,
    "-map", "0:v:0", "-map", `0:${audioStreamIndex}`,
    "-sn", "-dn", "-c:v", "copy",
    ...(videoCodec === "hevc" ? ["-tag:v", "hvc1"] : []),
    "-c:a", transcodeAudio ? "aac" : "copy",
    ...(transcodeAudio ? ["-profile:a", "aac_low", "-ac", String(channels), "-channel_layout", ({1:"mono",2:"stereo",6:"5.1",8:"7.1"})[channels] || `${channels}c`, "-aac_pce", "0", "-b:a", `${channels === 1 ? 96 : channels * 64 + (channels === 2 ? 64 : 0)}k`, "-threads:a", "2"] : []),
    "-f", "hls", "-hls_time", "4",
    "-hls_list_size", "0", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_flags", "temp_file",
    "-hls_segment_filename", outputPlaylist.replace(/\.m3u8$/i, "") + "-%06d.m4s",
    outputPlaylist
  ];
}
