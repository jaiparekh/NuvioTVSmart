import test from "node:test";
import assert from "node:assert/strict";
import { isPublicIpv4, preflightMkvSource } from "./mkvSourcePreflight.mjs";

test("public IPv4 classification denies private, metadata, reserved, and IPv6", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "198.18.0.1", "192.0.2.1", "::1", "fd00::1"]) {
    assert.equal(isPublicIpv4(address), false, address);
  }
  assert.equal(isPublicIpv4("8.8.8.8"), true);
  assert.equal(isPublicIpv4("1.1.1.1"), true);
});

test("preflight rejects DNS answers containing private or IPv6 addresses", async () => {
  const resolve = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "192.168.1.5", family: 4 }
  ];
  assert.equal((await preflightMkvSource("https://media.example.com/a.mkv",
    ["media.example.com"], resolve)).allowed, false);
  assert.equal((await preflightMkvSource("https://media.example.com/a.mkv",
    ["media.example.com"], async () => [{ address: "::1", family: 6 }])).allowed, false);
});

test("preflight permits an explicitly allowed host resolving to public IPv4 only", async () => {
  const result = await preflightMkvSource("https://media.example.com/a.mkv",
    ["media.example.com"], async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.deepEqual(result, {
    allowed: true, hostname: "media.example.com", addresses: ["8.8.8.8"]
  });
});

test("preflight fails closed on DNS errors and unauthorized hosts", async () => {
  assert.equal((await preflightMkvSource("https://media.example.com/a.mkv",
    ["media.example.com"], async () => { throw new Error("NXDOMAIN"); })).allowed, false);
  assert.equal((await preflightMkvSource("https://evil.example.com/a.mkv",
    ["media.example.com"], async () => { throw new Error("should not resolve"); })).reason,
  "host-not-allowlisted");
});

test("public HTTPS source does not require an allowlist", async () => {
  const resolve = async () => [{ address: "8.8.8.8", family: 4 }];
  assert.equal((await preflightMkvSource("https://cdn.example.com/movie.mkv", null, resolve)).allowed, true);
  assert.equal((await preflightMkvSource("https://cdn.example.com/movie.mkv", null, async () => [{ address: "10.0.0.1", family: 4 }])).allowed, false);
});
