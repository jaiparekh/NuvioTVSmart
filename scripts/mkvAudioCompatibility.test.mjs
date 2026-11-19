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

test("does not silently transcode unknown video codecs", () => {
  assert.equal(decideMkvAudioCompatibility({
    ...probe, video: [{ codec_name: "hevc" }]
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
