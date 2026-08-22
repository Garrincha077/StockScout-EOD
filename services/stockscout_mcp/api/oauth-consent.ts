import { createClient } from "@supabase/supabase-js";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

interface VercelRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(value: unknown): void;
};

interface StoredSession {
  access_token: string;
  refresh_token: string;
}

const SESSION_COOKIE = "__Host-stockscout_oauth";
const CSRF_COOKIE = "__Host-stockscout_csrf";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function cookieSecret(): string {
  const value = requiredEnvironment("MCP_CONSENT_COOKIE_SECRET");
  if (Buffer.byteLength(value) < 32) {
    throw new Error("MCP_CONSENT_COOKIE_SECRET must contain at least 32 bytes");
  }
  return value;
}

function signature(value: string): string {
  return createHmac("sha256", cookieSecret()).update(value).digest("base64url");
}

function seal(value: object): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${payload}.${signature(payload)}`;
}

function unseal<T>(value: string | undefined): T | null {
  if (!value) return null;
  const [payload, provided] = value.split(".");
  if (!payload || !provided) return null;
  const expected = signature(payload);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function formBody(request: VercelRequest): Record<string, string> {
  if (request.body && typeof request.body === "object") {
    return Object.fromEntries(
      Object.entries(request.body as Record<string, unknown>).map(([key, value]) => [
        key,
        String(value ?? ""),
      ]),
    );
  }
  if (typeof request.body === "string") {
    return Object.fromEntries(new URLSearchParams(request.body));
  }
  return {};
}

function queryValue(
  request: VercelRequest,
  name: string,
): string {
  const queryValue = request.query?.[name];
  if (Array.isArray(queryValue)) return queryValue[0] ?? "";
  if (typeof queryValue === "string") return queryValue;
  const requestUrl = new URL(request.url ?? "/", "https://stockscout.invalid");
  return requestUrl.searchParams.get(name) ?? "";
}

function authorizationId(request: VercelRequest, body: Record<string, string>): string {
  const value = (body.authorization_id || queryValue(request, "authorization_id")).trim();
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(value)) {
    throw new Error("Invalid authorization request");
  }
  return value;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(body: string, title = "StockScout authorization"): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px system-ui,sans-serif;background:#101418;color:#edf2f7;margin:0;padding:32px}
main{max-width:560px;margin:8vh auto;background:#182028;border:1px solid #33404d;border-radius:14px;padding:28px}
h1{font-size:24px;margin-top:0}label{display:block;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #536273;background:#0e141a;color:#fff}
button{padding:11px 18px;border-radius:8px;border:0;font-weight:650;cursor:pointer}
.approve{background:#4ade80;color:#092411}.deny{background:#475569;color:#fff}.actions{display:flex;gap:12px;margin-top:22px}
.meta{background:#0e141a;border-radius:8px;padding:14px;overflow-wrap:anywhere}.error{color:#fca5a5}
</style></head><body><main>${body}</main></body></html>`;
}

function sendHtml(response: VercelResponse, status: number, html: string): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.statusCode = status;
  response.end(html);
}

function redirect(response: VercelResponse, location: string, status = 303): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Location", location);
  response.end();
}

// OAuth clients expect the authorization server to redirect the browser back to
// their registered callback. Keep this separate from POST/redirect/GET above:
// 302 is the interoperable authorization-code redirect status.
function oauthCallbackRedirect(response: VercelResponse, location: string): void {
  redirect(response, location, 302);
}

function client() {
  return createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_PUBLISHABLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function csrfIsValid(body: Record<string, string>, requestCookies: Record<string, string>): boolean {
  const supplied = body.csrf ?? "";
  const stored = requestCookies[CSRF_COOKIE] ?? "";
  if (!supplied || supplied.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(stored));
}

function loginPage(
  authorizationIdValue: string,
  csrf: string,
  error = "",
): string {
  return page(`
<h1>Sign in to StockScout</h1>
<p>Authenticate before approving ChatGPT access to your private scanner data.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/oauth/consent">
<input type="hidden" name="authorization_id" value="${escapeHtml(authorizationIdValue)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="decision" value="login">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="actions"><button class="approve" type="submit">Sign in</button></div>
</form>
<p><a href="/password-reset?authorization_id=${encodeURIComponent(authorizationIdValue)}">Forgot password?</a></p>`);
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    sendHtml(response, 405, page("<h1>Method not allowed</h1>"));
    return;
  }

  const body = formBody(request);
  let authId: string;
  try {
    authId = authorizationId(request, body);
  } catch {
    sendHtml(response, 400, page("<h1>Invalid authorization request</h1>"));
    return;
  }
  const requestCookies = cookies(request);
  const csrf = requestCookies[CSRF_COOKIE] ?? randomBytes(24).toString("base64url");
  const storedSession = unseal<StoredSession>(requestCookies[SESSION_COOKIE]);
  const supabase = client();

  if (request.method === "POST" && !csrfIsValid(body, requestCookies)) {
    sendHtml(response, 403, page("<h1>Authorization request expired</h1>"));
    return;
  }

  if (request.method === "POST" && body.decision === "login") {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: body.email ?? "",
      password: body.password ?? "",
    });
    if (error || !data.session) {
      response.setHeader("Set-Cookie", cookie(CSRF_COOKIE, csrf, 600));
      sendHtml(response, 401, loginPage(authId, csrf, "Sign-in failed."));
      return;
    }
    response.setHeader("Set-Cookie", [
      cookie(
        SESSION_COOKIE,
        seal({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        }),
        900,
      ),
      cookie(CSRF_COOKIE, csrf, 600),
    ]);
    redirect(response, `/oauth/consent?authorization_id=${encodeURIComponent(authId)}`);
    return;
  }

  if (!storedSession) {
    response.setHeader("Set-Cookie", cookie(CSRF_COOKIE, csrf, 600));
    sendHtml(response, 200, loginPage(authId, csrf));
    return;
  }

  const { data: sessionData, error: sessionError } =
    await supabase.auth.setSession(storedSession);
  if (sessionError || !sessionData.session) {
    response.setHeader("Set-Cookie", [
      clearCookie(SESSION_COOKIE),
      cookie(CSRF_COOKIE, csrf, 600),
    ]);
    sendHtml(response, 401, loginPage(authId, csrf, "Session expired. Sign in again."));
    return;
  }

  if (
    request.method === "POST" &&
    ["approve", "deny"].includes(body.decision ?? "")
  ) {
    const operation =
      body.decision === "approve"
        ? supabase.auth.oauth.approveAuthorization(authId, {
            skipBrowserRedirect: true,
          })
        : supabase.auth.oauth.denyAuthorization(authId, {
            skipBrowserRedirect: true,
          });
    const { data, error } = await operation;
    if (data?.redirect_url) {
      oauthCallbackRedirect(response, data.redirect_url);
      return;
    }

    // A browser can resubmit the approval form while its first redirect is
    // still being handled. Supabase correctly marks that authorization as
    // consumed; if it can still supply the callback URL, resume it instead of
    // showing a misleading failure page.
    const { data: existing } = error
      ? await supabase.auth.oauth.getAuthorizationDetails(authId)
      : { data: null };
    if (existing && "redirect_url" in existing) {
      oauthCallbackRedirect(response, existing.redirect_url);
      return;
    }

    if (error) {
      sendHtml(response, 400, page("<h1>Authorization could not be completed</h1>"));
      return;
    }
    sendHtml(response, 400, page("<h1>Authorization could not be completed</h1>"));
    return;
  }

  const { data: details, error } =
    await supabase.auth.oauth.getAuthorizationDetails(authId);
  if (error || !details) {
    sendHtml(response, 400, page("<h1>Invalid or expired authorization request</h1>"));
    return;
  }
  if ("redirect_url" in details) {
    oauthCallbackRedirect(response, details.redirect_url);
    return;
  }

  response.setHeader("Set-Cookie", [
    cookie(
      SESSION_COOKIE,
      seal({
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
      }),
      900,
    ),
    cookie(CSRF_COOKIE, csrf, 600),
  ]);
  sendHtml(
    response,
    200,
    page(`
<h1>Authorize ${escapeHtml(details.client.name)}</h1>
<p>This client wants access to your private StockScout account.</p>
<div class="meta">
<strong>Client</strong><br>${escapeHtml(details.client.name)}<br><br>
<strong>Client URI</strong><br>${escapeHtml(details.client.uri)}<br><br>
<strong>Requested scopes</strong><br>${escapeHtml(details.scope)}<br><br>
<strong>Redirect URI</strong><br>${escapeHtml(details.redirect_uri)}
</div>
<p>Approval allows scanner reads, risk-preview requests, and explicitly confirmed untransmitted paper-TWS staging requests. It never grants a market-transmit tool.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="authorization_id" value="${escapeHtml(authId)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="actions">
<button class="approve" type="submit" name="decision" value="approve">Approve</button>
<button class="deny" type="submit" name="decision" value="deny">Deny</button>
</div>
</form>`),
  );
}
