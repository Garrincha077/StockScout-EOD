import assert from "node:assert/strict";
import test from "node:test";

import { requirePublishableSupabaseKey } from "../src/auth.js";

import {
  expectedAudience,
  oauthChallenge,
  oauthToolMeta,
  protectedResourceMetadata,
} from "../src/oauth.js";

const ENVIRONMENT_KEYS = [
  "SUPABASE_URL",
  "MCP_RESOURCE_URL",
  "MCP_RESOURCE_DOCUMENTATION_URL",
  "MCP_OAUTH_AUDIENCE",
  "MCP_OAUTH_SCOPES",
  "NODE_ENV",
] as const;

function withEnvironment(run: () => void): void {
  const previous = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.SUPABASE_URL = "https://project.supabase.co";
    process.env.MCP_RESOURCE_URL = "https://stockscout-eod-mcp.vercel.app/mcp";
    process.env.MCP_RESOURCE_DOCUMENTATION_URL =
      "https://garrincha077.github.io/StockScout-EOD/";
    process.env.MCP_OAUTH_AUDIENCE =
      "https://stockscout-eod-mcp.vercel.app/mcp";
    process.env.MCP_OAUTH_SCOPES = "email";
    process.env.NODE_ENV = "production";
    run();
  } finally {
    for (const key of ENVIRONMENT_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("OAuth protected-resource metadata, challenge and tool scheme agree", () => {
  withEnvironment(() => {
    assert.deepEqual(protectedResourceMetadata(), {
      resource: "https://stockscout-eod-mcp.vercel.app/mcp",
      authorization_servers: ["https://project.supabase.co/auth/v1"],
      scopes_supported: ["email"],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "https://garrincha077.github.io/StockScout-EOD",
    });
    assert.equal(
      oauthChallenge(),
      'Bearer resource_metadata="https://stockscout-eod-mcp.vercel.app/.well-known/oauth-protected-resource", scope="email"',
    );
    assert.deepEqual(oauthToolMeta(), {
      securitySchemes: [{ type: "oauth2", scopes: ["email"] }],
    });
    assert.equal(
      expectedAudience(),
      "https://stockscout-eod-mcp.vercel.app/mcp",
    );
  });
});

test("production rejects the generic Supabase audience", () => {
  withEnvironment(() => {
    process.env.MCP_OAUTH_AUDIENCE = "authenticated";
    assert.throws(() => expectedAudience(), /resource-specific/);
  });
});

function keyJwt(role: string): string {
  const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
  return `header.${payload}.signature`;
}

test("MCP rejects secret and service-role Supabase keys", () => {
  assert.equal(
    requirePublishableSupabaseKey("sb_publishable_abcdefghijklmnop"),
    "sb_publishable_abcdefghijklmnop",
  );
  assert.equal(requirePublishableSupabaseKey(keyJwt("anon")), keyJwt("anon"));
  assert.throws(
    () => requirePublishableSupabaseKey("sb_secret_abcdefghijklmnop"),
    /secret\/service-role/,
  );
  assert.throws(
    () => requirePublishableSupabaseKey(keyJwt("service_role")),
    /secret\/service-role/,
  );
});
