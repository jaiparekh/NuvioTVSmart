import test from "node:test";
import assert from "node:assert/strict";
import { shouldTryMkvBrowserCompatibility, requestMkvBrowserCompatibility } from "../js/core/player/mkvBrowserCompatibility.js";

const chrome = "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36";
test("Chrome MKV is eligible while Tizen and webOS are untouched", () => {
  assert.equal(shouldTryMkvBrowserCompatibility({ url: "https://media.example.com/movie.mkv", userAgent: chrome }), true);
  assert.equal(shouldTryMkvBrowserCompatibility({ url: "https://media.example.com/movie.mkv", userAgent: chrome, isTizen: true }), false);
  assert.equal(shouldTryMkvBrowserCompatibility({ url: "https://media.example.com/movie.mkv", userAgent: chrome, isWebOS: true }), false);
  assert.equal(shouldTryMkvBrowserCompatibility({ url: "https://media.example.com/movie.mp4", userAgent: chrome }), false);
  assert.equal(shouldTryMkvBrowserCompatibility({ url: "https://media.example.com/movie.mkv", userAgent: "Firefox/133" }), false);
});
test("session negotiation fails closed when disabled", async () => {
  const result = await requestMkvBrowserCompatibility("https://media.example.com/movie.mkv", {
    fetchImpl: async () => ({ ok: false })
  });
  assert.equal(result, null);
});
test("session negotiation accepts only internal HLS URLs", async () => {
  const result = await requestMkvBrowserCompatibility("https://media.example.com/movie.mkv", {
    fetchImpl: async () => ({
      ok: true, json: async () => ({ action: "hls-session", playlistUrl: "https://evil.example.com/playlist.m3u8" })
    })
  });
  assert.equal(result, null);
});
