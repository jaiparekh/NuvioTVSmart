/** Browser-only, fail-closed MKV audio compatibility request. */
export function shouldTryMkvBrowserCompatibility({ url, userAgent, isTizen = false, isWebOS = false }) {
  if (isTizen || isWebOS) return false;
  const agent = String(userAgent || "");
  if (!/Chrome\/\d+/.test(agent) || /Edg\/|OPR\/|SamsungBrowser\//.test(agent)) return false;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && /\.mkv$/i.test(parsed.pathname);
  } catch { return false; }
}

export async function requestMkvBrowserCompatibility(sourceUrl, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl("/api/mkv-browser/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceUrl }),
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) return null;
  const result = await response.json();
  if (result?.action !== "hls-session" ||
      typeof result.playlistUrl !== "string" ||
      !/^\/api\/mkv-hls\/[0-9a-f-]{36}\/index\.m3u8$/.test(result.playlistUrl)) return null;
  return result;
}

/** Best-effort cleanup when switching media sources. */
export async function closeMkvBrowserCompatibility(id, { fetchImpl = fetch } = {}) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return false;
  try {
    const response = await fetchImpl(`/api/mkv-browser/session/${id}`, {
      method: "DELETE", credentials: "same-origin"
    });
    return response.ok;
  } catch { return false; }
}

/** Request a fresh HLS session for a different embedded track or source offset. */
export async function replaceMkvBrowserCompatibility(id, { audioStreamIndex = null, startSeconds = 0 } = {}, { fetchImpl = fetch } = {}) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return null;
  if (audioStreamIndex != null && (!Number.isSafeInteger(audioStreamIndex) || audioStreamIndex < 0)) return null;
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 86400) return null;
  try {
    const response = await fetchImpl(`/api/mkv-browser/session/${id}`, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioStreamIndex, startSeconds }),
      signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (result?.action !== "hls-session" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(result.id || "") ||
        result.playlistUrl !== `/api/mkv-hls/${result.id}/index.m3u8`) return null;
    return result;
  } catch { return null; }
}
