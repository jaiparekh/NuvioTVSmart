import test from "node:test";
import assert from "node:assert/strict";
import { decideMkvAudioCompatibility, buildMkvHlsArguments } from "./mkvAudioCompatibility.mjs";

const probe = {
  video: [{ index: 0, codec_name: "h264" }],
  audio: [
    { index: 1, codec: "eac3", language: "en", channels: 6 },
    { index: 2, codec: "aac", language: "hi", channels: 2 },
    { index: 3, codec: "dts", language: "fr", channels: 6 }
  ]
};

test("automatically converts E-AC3 but copies H.264 video", () => {
  assert.deepEqual(decideMkvAudioCompatibility(probe), {
    action: "transcode-audio", reason: "unsupported-audio", audioStreamIndex: 1,
    outputCodec: "aac", videoMode: "copy"
  });
});

test("does not convert compatible AAC", () => {
  assert.equal(decideMkvAudioCompatibility(probe, { selectedAudioStreamIndex: 2 }).action, "direct");
});

test("preserves actual container stream index for alternate audio", () => {
  const decision = decideMkvAudioCompatibility(probe, { selectedAudioStreamIndex: 3 });
  assert.equal(decision.audioStreamIndex, 3);
  const args = buildMkvHlsArguments({
    sourceUrl: "https://example.org/movie.mkv",
    audioStreamIndex: decision.audioStreamIndex,
    outputPlaylist: "/tmp/session/index.m3u8"
  });
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-sn")), [
    "-map", "0:v:0", "-map", "0:3"
  ]);
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-f")), [
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k"
  ]);
});

test("copies HEVC while converting E-AC3 to AAC", () => {
  const result = decideMkvAudioCompatibility({ ...probe, video: [{ codec_name: "hevc" }] });
  assert.equal(result.action, "transcode-audio");
  assert.equal(result.videoMode, "copy");
  assert.equal(result.outputCodec, "aac");
});

test("does not silently transcode unknown video codecs", () => {
  assert.equal(decideMkvAudioCompatibility({
    ...probe, video: [{ codec_name: "unknown" }]
  }).action, "unchanged");
});

test("does not silently choose a different track when selection is invalid", () => {
  assert.equal(decideMkvAudioCompatibility(probe, { selectedAudioStreamIndex: 99 }).reason, "audio-stream-not-found");
});

test("rejects unsafe FFmpeg stream indexes", () => {
  assert.throws(() => buildMkvHlsArguments({
    sourceUrl: "https://example.org/a.mkv", audioStreamIndex: -1, outputPlaylist: "/tmp/x.m3u8"
  }));
});

test("publishes HLS progressively without deleting earlier segments", () => {
  const args = buildMkvHlsArguments({
    sourceUrl: "https://example.org/movie.mkv",
    audioStreamIndex: 1,
    outputPlaylist: "/tmp/session/index.m3u8",
    startSeconds: 120
  });
  assert.deepEqual(args.slice(args.indexOf("-hls_list_size"), args.indexOf("-hls_segment_filename")), [
    "-hls_list_size", "0", "-hls_playlist_type", "event"
  ]);
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-i")), ["-ss", "120"]);
});

test("rejects non-http inputs and embedded URL credentials", () => {
  for (const sourceUrl of ["file:///etc/passwd", "http://user:pass@example.org/movie.mkv", "not-a-url"]) {
    assert.throws(() => buildMkvHlsArguments({
      sourceUrl, audioStreamIndex: 1, outputPlaylist: "/tmp/session/index.m3u8"
    }));
  }
});

test("compatible alternate audio is copied while preserving HLS transport", () => {
  const decision = decideMkvAudioCompatibility(probe, { selectedAudioStreamIndex: 2 });
  assert.equal(decision.action, "direct");
  const args = buildMkvHlsArguments({
    sourceUrl: "http://127.0.0.1:4000/pinned-source",
    audioStreamIndex: decision.audioStreamIndex,
    outputPlaylist: "/tmp/session/index.m3u8",
    transcodeAudio: false
  });
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-f")),
    ["-c:v", "copy", "-c:a", "copy"]);
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-sn")),
    ["-map", "0:v:0", "-map", "0:2"]);
});

test("replacement seek is applied to the FFmpeg source", () => {
  const args = buildMkvHlsArguments({
    sourceUrl: "http://127.0.0.1:4000/pinned-source",
    audioStreamIndex: 3,
    outputPlaylist: "/tmp/session/index.m3u8",
    startSeconds: 123.5
  });
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-i")), ["-ss", "123.5"]);
});
