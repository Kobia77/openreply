import { requireEnv } from "@/lib/env";

// Meta stopped offering "API setup with Instagram login" to newly created apps
// (late October 2026). Those apps only get "API setup with Unified login":
// Facebook Login for Business with a config_id, which returns a never-expiring
// system-user token. That token is rejected by graph.instagram.com and works
// on graph.facebook.com against the same Instagram account node paths.
//
// META_LOGIN_MODE=unified switches the whole Meta integration to that flow.
// Unset (or "instagram"), everything behaves exactly as before.
export function isUnifiedLogin(): boolean {
  return process.env.META_LOGIN_MODE === "unified";
}

export function getLoginConfigId(): string {
  return requireEnv("META_LOGIN_CONFIG_ID");
}

// Without the business_management permission, which a system-user token only
// keeps once public_profile has Advanced Access (App Review), the token cannot
// list its assigned Instagram accounts. It can still read and act on the
// account by ID, so the professional account ID is configured explicitly.
export function getUnifiedInstagramAccountId(): string {
  return requireEnv("META_INSTAGRAM_ACCOUNT_ID");
}
