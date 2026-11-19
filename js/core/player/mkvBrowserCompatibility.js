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
