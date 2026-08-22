import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  AuthenticationError,
  expectedAudience,
  oauthScopes,
} from "./oauth.js";

export interface AuthenticatedContext {
  userId: string;
  database: SupabaseClient;
  oauthClientId: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }
  return value;
}

const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9._-]{16,}$/;

function publicKeyRole(value: string): string | null {
  const payload = value.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return decoded && typeof decoded === "object" && typeof decoded.role === "string"
      ? decoded.role
      : null;
  } catch {
    return null;
  }
}

export function requirePublishableSupabaseKey(value: string): string {
  const key = value.trim();
  if (PUBLISHABLE_KEY.test(key) || publicKeyRole(key) === "anon") return key;
  throw new Error(
    "Supabase MCP key must be publishable or a legacy anon JWT; secret/service-role keys are forbidden",
  );
}

function publishableKey(): string {
  const value =
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!value) {
    throw new Error(
      "Missing SUPABASE_PUBLISHABLE_KEY (or legacy SUPABASE_ANON_KEY)",
    );
  }
  return requirePublishableSupabaseKey(value);
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new AuthenticationError();
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    throw new AuthenticationError();
  }
  return token;
}

interface JwtClaims {
  aud?: unknown;
  client_id?: unknown;
  exp?: unknown;
  role?: unknown;
  scope?: unknown;
  sub?: unknown;
}

function decodeClaims(token: string): JwtClaims {
  const payload = token.split(".")[1];
  if (!payload) throw new AuthenticationError();
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object") throw new Error("invalid JWT");
    return decoded as JwtClaims;
  } catch {
    throw new AuthenticationError();
  }
}

function audienceContains(value: unknown, expected: string): boolean {
  return typeof value === "string"
    ? value === expected
    : Array.isArray(value) && value.includes(expected);
}

function grantedScopes(value: unknown): Set<string> {
  if (typeof value === "string") {
    return new Set(value.split(/\s+/).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return new Set(value.filter((item): item is string => typeof item === "string"));
  }
  return new Set();
}

export async function authenticate(
  authorization: string | undefined,
): Promise<AuthenticatedContext> {
  const token = bearerToken(authorization);
  const url = requiredEnvironment("SUPABASE_URL");
  const key = publishableKey();
  const verifier = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  const { data, error } = await verifier.auth.getUser(token);
  if (error || !data.user) {
    throw new AuthenticationError();
  }
  const claims = decodeClaims(token);
  const clientId =
    typeof claims.client_id === "string" ? claims.client_id.trim() : "";
  const requiredScopes = oauthScopes();
  const scopes = grantedScopes(claims.scope);
  if (
    claims.sub !== data.user.id ||
    claims.role !== "authenticated" ||
    typeof claims.exp !== "number" ||
    claims.exp <= Math.floor(Date.now() / 1000) ||
    !audienceContains(claims.aud, expectedAudience()) ||
    !clientId ||
    requiredScopes.some((scope) => !scopes.has(scope))
  ) {
    throw new AuthenticationError();
  }
  // User operations deliberately use the publishable key plus the verified
  // user's JWT. This preserves auth.uid(), RLS, and SECURITY INVOKER behavior;
  // the server-only secret is never used as the database role for user tools.
  const database = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  return { userId: data.user.id, database, oauthClientId: clientId };
}
