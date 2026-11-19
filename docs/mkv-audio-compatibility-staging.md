# MKV audio compatibility — staging API

This is an experimental backend interface on `feature/mkv-audio-compatibility`.
It is **not** a production-ready browser playback feature. Do not merge or
expose it publicly without an authentication and security review.

## Server configuration

Set the following **server-only** environment variables (never put the token
in `local.properties` if that file is served to clients):

```sh
NUVIO_MKV_API_TOKEN='<random-secret-at-least-32-characters>'
NUVIO_MKV_ALLOWED_HOSTS='media.example.com,cdn.example.com'
```

Only HTTPS upstream URLs are supported. Exact hostname matches are required.
Redirects, local addresses and mixed public/private DNS answers are rejected.
The upstream must permit Range requests. The server uses absolute FFmpeg and
FFprobe paths; **do not override Docker Compose PATH**.

## Staging test

Run against a **private** development server only:

```sh
curl -fsS -X POST http://127.0.0.1:4173/api/mkv-hls/session \
  -H "Authorization: Bearer $NUVIO_MKV_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"sourceUrl":"https://media.example.com/movie.mkv"}'
```

For an E-AC3 MKV with H.264 video, a successful response contains
`action: "transcode-audio"`, `id`, and `playlistUrl`.
For compatible audio, the response may be `action: "direct"` without a session.
The returned playlist is at `/api/mkv-hls/<id>/index.m3u8`.

Stop a session:

```sh
curl -X DELETE "http://127.0.0.1:4173/api/mkv-hls/session/<id>" \
  -H "Authorization: Bearer $NUVIO_MKV_API_TOKEN"
```

## Known gaps

- The browser player does not call this API yet; do not ship the bearer token
  to the frontend.
- Audio-track selection, seeking and session ownership are not integrated.
- Generated playlist/segment URLs are capability-scoped, not per-user authenticated.
- The server currently reports media startup errors as generic 422 responses.
- Range behavior, HLS playback, FFmpeg process cleanup and security boundaries
  require live tests with real MKV media before production use.
- Upstream authorization headers and redirected media URLs are not supported.

## Audio-track switching and seeking (staging API)

Once a session has been created, replace it using its returned `id`:

```sh
curl -fsS -X PUT "http://127.0.0.1:4173/api/mkv-hls/session/<id>" \\
  -H "Authorization: Bearer $NUVIO_MKV_API_TOKEN" \\
  -H 'Content-Type: application/json' \\
  --data '{"audioStreamIndex":3,"startSeconds":120}'
```

The response contains a **new** session ID and playlist URL; use that URL
for subsequent playback. The previous session is stopped first, so a failed
replacement cannot resume the old session. Omit `audioStreamIndex` to retain
the selected track. The original upstream URL is kept on the server and is
never accepted from the replacement request. The client must track the new ID
for future replacements or teardown.

**Current limitations:** The browser is not yet wired to this endpoint.
Seeking creates a new HLS timeline starting at the requested source offset;
clients must restore the displayed absolute playback position separately.
Switching to an already compatible AAC/MP3 track retains an HLS session,
copying the compatible audio rather than transcoding it. The API is not suitable for
multi-user production use until session ownership and rate limits are added.

## Chrome browser bridge (experimental)

The Chrome player now attempts automatic HLS compatibility for URLs whose path
ends in `.mkv`. The request is **fail-closed**: if the bridge is disabled or
fails, the existing player path is used. Tizen and webOS are excluded.

This bridge requires an **authenticated HTTPS reverse proxy on the same host**.
Do not enable it on an Internet-facing, unauthenticated Nuvio installation.
The Node application must be bound to loopback so clients cannot bypass proxy
authentication. Example server-only environment:

```sh
HOST=127.0.0.1
NUVIO_MKV_BROWSER_ENABLED=1
NUVIO_MKV_BROWSER_AUTHENTICATED_PROXY=1
NUVIO_MKV_ALLOWED_HOSTS=media.example.com
```

The proxy must authenticate every browser request, forward the original Host
header, set `X-Forwarded-Proto: https`, and forward the browser's Origin and
Sec-Fetch-Site headers. The Node app must not be reachable directly from the
network. The two browser flags are an **operator attestation**, not a built-in
login system; never set them without an enforced proxy authentication layer.

The browser bridge creates a server-side session without exposing the staging
bearer token. It supports initial HLS playback, best-effort teardown on source change,
and a browser-accessible PUT replacement endpoint for audio changes and seeks.
The JavaScript client can call that endpoint, but the audio dialog and seek
controls are **not yet wired** to invoke it.
Signed URLs whose path does not end in `.mkv` are not automatically detected.

This is experimental and must be tested in Chrome with real signed media before
considering a production rollout. In particular, the player startup path,
subtitles, track discovery, and session cleanup need integration validation.

## Browser replacement request

The authenticated browser session bridge supports `PUT
/api/mkv-browser/session/<id>` with JSON
`{"audioStreamIndex":3,"startSeconds":120}`. It returns a new session ID and
HLS playlist URL. The old session is closed before replacement. Chrome's
initial compatibility playback explicitly uses `hls.js` and clears upstream
MKV request headers for the same-origin HLS playlist. Browser playback has
not yet been tested with a real media provider.

### Track switching behavior

When an HLS compatibility session is active, the audio dialog displays the
original probed MKV audio tracks (language, title and codec when available).
Selecting another track replaces the server-side HLS session and restarts
hls.js at the current absolute source position. This is a first integration
pass; it needs real-browser verification for focus handling, subtitle
continuity, progress persistence and recovery from replacement failure.
