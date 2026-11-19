import test from "node:test";
import assert from "node:assert/strict";
import { firstHlsSegmentName } from "./mkvPlaylist.mjs";

test("finds first segment in FFmpeg event playlist", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXTINF:4.000000,",
    "index-000000.ts",
    "#EXTINF:4.000000,",
    "index-000001.ts",
    ""
  ].join("\n");
  assert.equal(firstHlsSegmentName(playlist), "index-000000.ts");
});

test("handles CRLF and rejects non-segment lines", () => {
  assert.equal(firstHlsSegmentName("#EXTM3U\r\nindex-000042.ts\r\n"), "index-000042.ts");
  assert.equal(firstHlsSegmentName("#EXTM3U\n#EXTINF:4\n"), null);
  assert.equal(firstHlsSegmentName("#EXTM3U\n../index-000001.ts\n"), null);
});
