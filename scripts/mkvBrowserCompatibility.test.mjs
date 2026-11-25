import test from "node:test";
import assert from "node:assert/strict";
import { shouldTryMkvBrowserCompatibility, requestMkvBrowserCompatibility, replaceMkvBrowserCompatibility, closeMkvBrowserCompatibility } from "../js/core/player/mkvBrowserCompatibility.js";

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

test("browser replacement sends selected stream index and seek offset", async () => {
  const oldId = "11111111-1111-4111-8111-111111111111";
  const newId = "22222222-2222-4222-8222-222222222222";
  let called = false;
  const result = await replaceMkvBrowserCompatibility(oldId, {
    audioStreamIndex: 3, startSeconds: 120
  }, { fetchImpl: async (url, options) => {
    called = true;
    assert.equal(url, `/api/mkv-browser/session/${oldId}`);
    assert.equal(options.method, "PUT");
    assert.deepEqual(JSON.parse(options.body), { audioStreamIndex: 3, startSeconds: 120 });
    return { ok: true, json: async () => ({
      action: "hls-session", id: newId,
      playlistUrl: `/api/mkv-hls/${newId}/index.m3u8`
    }) };
  }});
  assert.equal(called, true);
  assert.equal(result.id, newId);
});
test("browser replacement rejects unsafe indexes and external playlists", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(await replaceMkvBrowserCompatibility(id, { audioStreamIndex: -1 }), null);
  assert.equal(await replaceMkvBrowserCompatibility(id, {}, {
    fetchImpl: async () => ({ ok: true, json: async () => ({
      action: "hls-session", id, playlistUrl: "https://elsewhere.example.com/master.m3u8"
    }) })
  }), null);
});
test("browser cleanup uses DELETE on a valid session id", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(await closeMkvBrowserCompatibility(id, { fetchImpl: async (url, options) => {
    assert.equal(url, `/api/mkv-browser/session/${id}`);
    assert.equal(options.method, "DELETE");
    return { ok: true };
  }}), true);
});

test("Chrome negotiates opaque HTTPS URLs and MKV source hints", () => {
  const eligible = (url, likelyMkv = false) => shouldTryMkvBrowserCompatibility({ url, userAgent: chrome, likelyMkv });
  assert.equal(eligible("https://media.example.com/stream/123?token=abc"), true);
  assert.equal(eligible("https://media.example.com/stream.php", true), true);
  assert.equal(eligible("https://media.example.com/live.m3u8", true), false);
  assert.equal(eligible("https://media.example.com/video.mp4", true), false);
  assert.equal(eligible("http://media.example.com/movie.mkv"), false);
});
