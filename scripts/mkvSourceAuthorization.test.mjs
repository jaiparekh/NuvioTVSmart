import test from "node:test";
import assert from "node:assert/strict";
import { validateMkvSourceHost } from "./mkvSourceAuthorization.mjs";

const hosts = ["media.example.com"];

test("allows only explicitly configured exact hosts", () => {
  assert.deepEqual(validateMkvSourceHost("https://media.example.com/video.mkv", hosts), {
    allowed: true, hostname: "media.example.com"
  });
  assert.equal(validateMkvSourceHost("https://sub.media.example.com/a.mkv", hosts).allowed, false);
  assert.equal(validateMkvSourceHost("https://media.example.com.evil.test/a.mkv", hosts).allowed, false);
  assert.equal(validateMkvSourceHost("https://media.example.com/a.mkv", []).allowed, false);
});

test("rejects local, IP, malformed, credentialed, and non-HTTP URLs", () => {
  for (const url of [
    "http://127.0.0.1/a.mkv", "http://[::1]/a.mkv",
    "http://localhost/a.mkv", "http://device.local/a.mkv",
    "http://user:password@media.example.com/a.mkv",
    "file:///etc/passwd", "garbage"
  ]) {
    assert.equal(validateMkvSourceHost(url, hosts).allowed, false, url);
  }
});
