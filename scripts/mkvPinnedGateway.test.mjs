import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPinnedMkvGateway } from "./mkvPinnedGateway.mjs";

test("gateway rejects HTTP sources before any DNS resolution", async () => {
  await assert.rejects(
    createPinnedMkvGateway("http://media.example.com/movie.mkv", ["media.example.com"]),
    /HTTPS media source required/
  );
});

test("gateway rejects insecure redirect source schemes", async () => {
  await assert.rejects(createPinnedMkvGateway("ftp://media.example.com/movie.mkv"), /HTTPS media source required/);
});

test("gateway rejects localhost and IP-literal sources", async () => {
  for (const url of ["https://127.0.0.1/file.mkv", "https://localhost/file.mkv"]) {
    await assert.rejects(createPinnedMkvGateway(url, [new URL(url).hostname]));
  }
});
