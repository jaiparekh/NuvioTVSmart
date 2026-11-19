import { TRAKT_CLIENT_ID } from "../../config.js";
import { ProfileManager } from "../../core/profile/profileManager.js";
import { TraktAuthStore } from "../local/traktAuthStore.js";

const KEY = "nuvioTraktPkce";
const redirectUri = () => `${location.origin}/trakt/callback`;
const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const random = (length) => { const b = new Uint8Array(length); crypto.getRandomValues(b); return encode(b); };

export const TraktBrowserAuth = {
  async start() {
    if (!TRAKT_CLIENT_ID) throw new Error("Missing TRAKT_CLIENT_ID");
    if (!globalThis.crypto?.subtle) throw new Error("Trakt login requires HTTPS");
    const verifier = random(48);
    const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const state = random(24);
    sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, profileId: String(ProfileManager.getActiveProfileId()), created: Date.now() }));
    const url = new URL("https://trakt.tv/oauth/authorize");
    for (const [key, value] of Object.entries({ response_type: "code", client_id: TRAKT_CLIENT_ID, redirect_uri: redirectUri(), state, code_challenge: challenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
    location.assign(url.toString());
  },
  async complete() {
    const query = new URLSearchParams(location.search);
    const error = query.get("trakt_error");
    if (error) throw new Error(query.get("trakt_error_description") || error);
    const code = query.get("trakt_code");
    if (!code) return;
    const pending = JSON.parse(sessionStorage.getItem(KEY) || "null");
    sessionStorage.removeItem(KEY);
    if (!pending || Date.now() - pending.created > 600000 || pending.state !== query.get("trakt_state")) throw new Error("Trakt login expired or state mismatch");
    if (String(ProfileManager.getActiveProfileId()) !== pending.profileId) throw new Error("Trakt profile changed during login");
    const response = await fetch("/trakt/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: TRAKT_CLIENT_ID, redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: pending.verifier })
    });
    const contentType = response.headers.get("content-type") || "missing";
    const rawResponse = await response.text();
    let payload;
    try {
      payload = JSON.parse(rawResponse);
    } catch {
      // Never include the upstream response body: it may contain HTML or sensitive data.
      throw new Error(`Trakt token exchange returned non-JSON (HTTP ${response.status}, Content-Type: ${contentType})`);
    }
    if (!response.ok || !payload?.access_token) {
      // OAuth error fields are expected, but do not surface arbitrary upstream HTML.
      const oauthError = typeof payload?.error === "string" ? payload.error : "token_exchange_failed";
      throw new Error(`Trakt token exchange failed (HTTP ${response.status}, Content-Type: ${contentType}, error: ${oauthError})`);
    }
    TraktAuthStore.saveToken(payload, pending.profileId);
    history.replaceState(null, "", "/");
    location.replace("/");
  }
};
