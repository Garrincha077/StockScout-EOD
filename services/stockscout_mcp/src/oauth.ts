export class AuthenticationError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthenticationError";
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }
  return value;
}

function httpsUrl(name: string, value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error(`${name} must use HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function resourceUrl(): string {
  return httpsUrl(
    "MCP_RESOURCE_URL",
    requiredEnvironment("MCP_RESOURCE_URL"),
  );
}

export function authorizationServerUrl(): string {
  const supabaseUrl = httpsUrl(
    "SUPABASE_URL",
    requiredEnvironment("SUPABASE_URL"),
  );
  return `${supabaseUrl}/auth/v1`;
}

export function oauthScopes(): string[] {
  const configured = process.env.MCP_OAUTH_SCOPES ?? "email";
  const scopes = [...new Set(configured.split(/\s+/).filter(Boolean))];
  if (scopes.length === 0) {
    throw new Error("MCP_OAUTH_SCOPES must contain at least one scope");
  }
  return scopes;
}

export function expectedAudience(): string {
  const audience = (process.env.MCP_OAUTH_AUDIENCE ?? "authenticated").trim();
  if (!audience) {
    throw new Error("MCP_OAUTH_AUDIENCE must not be empty");
  }
  if (
    process.env.NODE_ENV === "production" &&
    audience === "authenticated"
  ) {
    throw new Error(
      "Production MCP_OAUTH_AUDIENCE must be resource-specific; configure a Supabase custom access-token hook",
    );
  }
  return audience;
}

export function protectedResourceMetadata(): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    resource: resourceUrl(),
    authorization_servers: [authorizationServerUrl()],
    scopes_supported: oauthScopes(),
    bearer_methods_supported: ["header"],
  };
  const documentation = process.env.MCP_RESOURCE_DOCUMENTATION_URL?.trim();
  if (documentation) {
    metadata.resource_documentation = httpsUrl(
      "MCP_RESOURCE_DOCUMENTATION_URL",
      documentation,
    );
  }
  return metadata;
}

export function oauthChallenge(): string {
  const metadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    resourceUrl(),
  ).toString();
  return `Bearer resource_metadata="${metadataUrl}", scope="${oauthScopes().join(" ")}"`;
}

export function oauthToolMeta(): Record<string, unknown> {
  return {
    securitySchemes: [{ type: "oauth2", scopes: oauthScopes() }],
  };
}
