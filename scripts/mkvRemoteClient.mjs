// Optional internal Docker worker transport. Local implementation remains the default.
import { readHlsAsset as localRead, closeAllHlsSessions as localCloseAll, createAuthorizedMkvSession as localCreate, replaceAuthorizedMkvSession as localReplace, closeHlsSession as localClose } from "./mkvHlsSessions.mjs";
const base = process.env.NUVIO_MKV_WORKER_URL;
const token = process.env.NUVIO_MKV_WORKER_TOKEN;
async function request(method, route, body) {
  if (!base || !token || token.length < 32) throw new Error("MKV worker is not configured");
  const url = new URL(route, base);
  if (url.origin !== new URL(base).origin || url.protocol !== "http:") throw new Error("Invalid worker address");
  const response = await fetch(url, {
    method, headers: { "Authorization": `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`MKV worker request failed (${response.status})`);
  if (response.status === 204) return null;
  if (route.includes("/asset/")) return { contentType: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
  return response.json();
}
export const createAuthorizedMkvSession = (input) => base ? request("POST", "/session", input) : localCreate(input);
export const replaceAuthorizedMkvSession = (input) => base ? request("PUT", "/session/" + encodeURIComponent(input.id), input) : localReplace(input);
export const closeHlsSession = (id) => base ? request("DELETE", "/session/" + encodeURIComponent(id)) : localClose(id);
export const readHlsAsset = (id, filename) => base ? request("GET", "/asset/" + encodeURIComponent(id) + "/" + encodeURIComponent(filename)) : localRead(id, filename);
export const closeAllHlsSessions = () => base ? Promise.resolve() : localCloseAll();
