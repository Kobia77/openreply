import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMissingInstagramOAuthEnv } from "../lib/env";
import {
  getUserInfo,
  getUserMedia,
  sendPrivateReply,
} from "../lib/meta/client";
import { exchangeCodeForToken, getAuthorizationUrl } from "../lib/meta/oauth";

const IG_ACCOUNT_ID = "17841400000000000";
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INSTAGRAM_APP_ID", "1234567890");
  vi.stubEnv("INSTAGRAM_APP_SECRET", "app-secret");
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef".repeat(4));
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Instagram login (default mode)", () => {
  it("keeps the Instagram authorize URL and scopes", () => {
    const url = new URL(getAuthorizationUrl("https://app.test/cb", "state"));
    expect(url.origin + url.pathname).toBe(
      "https://www.instagram.com/oauth/authorize"
    );
    expect(url.searchParams.get("scope")).toContain("instagram_business_basic");
    expect(url.searchParams.get("config_id")).toBeNull();
  });

  it("keeps calling graph.instagram.com/me", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "app-scoped", user_id: IG_ACCOUNT_ID, username: "acct" })
    );
    await getUserInfo("token");
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe("graph.instagram.com");
    expect(url.pathname).toMatch(/\/me$/);
  });

  it("does not require the Unified login variables", () => {
    expect(getMissingInstagramOAuthEnv()).toEqual([]);
  });
});

describe("Unified login (META_LOGIN_MODE=unified)", () => {
  beforeEach(() => {
    vi.stubEnv("META_LOGIN_MODE", "unified");
    vi.stubEnv("META_LOGIN_CONFIG_ID", "999888777");
    vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", IG_ACCOUNT_ID);
  });

  it("requires the config ID and the Instagram account ID", () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "");
    vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", "");
    expect(getMissingInstagramOAuthEnv()).toEqual([
      "META_LOGIN_CONFIG_ID",
      "META_INSTAGRAM_ACCOUNT_ID",
    ]);
  });

  it("builds a Facebook Login for Business URL with config_id and no scope", () => {
    const url = new URL(getAuthorizationUrl("https://app.test/cb", "state"));
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/v25.0/dialog/oauth"
    );
    expect(url.searchParams.get("config_id")).toBe("999888777");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/cb");
    expect(url.searchParams.get("state")).toBe("state");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("exchanges the code on graph.facebook.com and returns the configured account", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: "suat-token", token_type: "bearer" })
    );
    const result = await exchangeCodeForToken("the-code", "https://app.test/cb");
    expect(result).toEqual({ accessToken: "suat-token", userId: IG_ACCOUNT_ID });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v25.0/oauth/access_token"
    );
    expect(url.searchParams.get("code")).toBe("the-code");
    expect(url.searchParams.get("client_secret")).toBe("app-secret");
  });

  it("surfaces Meta's error message when the exchange fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Code expired" } }, 400)
    );
    await expect(
      exchangeCodeForToken("old-code", "https://app.test/cb")
    ).rejects.toThrow("Token exchange failed: Code expired");
  });

  it("reads the account by ID on graph.facebook.com and fills user_id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: IG_ACCOUNT_ID, username: "tech.ops.il" })
    );
    const user = await getUserInfo("suat-token");
    expect(user.user_id).toBe(IG_ACCOUNT_ID);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe("graph.facebook.com");
    expect(url.pathname).toBe(`/v25.0/${IG_ACCOUNT_ID}`);
    expect(url.searchParams.get("fields")).not.toContain("user_id");
  });

  it("lists media from the account node instead of /me", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await getUserMedia("suat-token", 5);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.host).toBe("graph.facebook.com");
    expect(url.pathname).toBe(`/v25.0/${IG_ACCOUNT_ID}/media`);
  });

  it("sends private replies through graph.facebook.com", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ recipient_id: "r", message_id: "m" })
    );
    await sendPrivateReply("suat-token", IG_ACCOUNT_ID, "comment-1", "hi");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://graph.facebook.com/v25.0/${IG_ACCOUNT_ID}/messages`
    );
  });
});
