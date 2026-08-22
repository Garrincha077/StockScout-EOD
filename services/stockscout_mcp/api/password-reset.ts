import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";

interface VercelRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(value: unknown): void;
};

const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{8,512}$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function publicOrigin(): string {
  return new URL(requiredEnvironment("MCP_RESOURCE_URL")).origin;
}

function client() {
  return createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_PUBLISHABLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function body(request: VercelRequest): Record<string, unknown> {
  if (request.body && typeof request.body === "object") {
    return request.body as Record<string, unknown>;
  }
  if (typeof request.body === "string") {
    return Object.fromEntries(new URLSearchParams(request.body));
  }
  return {};
}

function query(request: VercelRequest, name: string): string {
  const fromQuery = request.query?.[name];
  if (Array.isArray(fromQuery)) return fromQuery[0] ?? "";
  if (typeof fromQuery === "string") return fromQuery;
  return new URL(request.url ?? "/", publicOrigin()).searchParams.get(name) ?? "";
}

function resumeUrl(request: VercelRequest): string {
  const authorizationId = query(request, "authorization_id");
  return AUTHORIZATION_ID.test(authorizationId)
    ? `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`
    : "/";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(request: VercelRequest): string {
  const resume = resumeUrl(request);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset StockScout password</title>
<style>
body{font:16px system-ui,sans-serif;background:#101418;color:#edf2f7;margin:0;padding:32px}
main{max-width:560px;margin:8vh auto;background:#182028;border:1px solid #33404d;border-radius:14px;padding:28px}
h1{font-size:24px;margin-top:0}label{display:block;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;border:1px solid #536273;background:#0e141a;color:#fff}
button{padding:11px 18px;border-radius:8px;border:0;font-weight:650;cursor:pointer}.approve{background:#4ade80;color:#092411}
.actions{display:flex;gap:12px;margin-top:22px}.error{color:#fca5a5}.success{color:#86efac}.hidden{display:none}
</style></head><body><main>
<section id="request-panel"><h1>Reset StockScout password</h1>
<p>Enter your StockScout email. If it has an account, we will send a one-time reset link.</p>
<form id="request-form"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
<div class="actions"><button class="approve" type="submit">Send reset link</button></div></form>
<p id="request-message" role="status"></p></section>
<section id="update-panel" class="hidden"><h1>Choose a new password</h1>
<p>Use at least 12 characters. This reset link can be used once.</p>
<form id="update-form"><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
<label for="confirmation">Confirm new password</label><input id="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="12" required>
<div class="actions"><button class="approve" type="submit">Set new password</button></div></form>
<p id="update-message" role="status"></p><p><a id="resume" href="${escapeHtml(resume)}">Return to StockScout sign-in</a></p></section>
</main><script src="/api/password-reset?script=1"></script></body></html>`;
}

function script(): string {
  return `(() => {
  const requestPanel = document.querySelector("#request-panel");
  const updatePanel = document.querySelector("#update-panel");
  const requestForm = document.querySelector("#request-form");
  const updateForm = document.querySelector("#update-form");
  const requestMessage = document.querySelector("#request-message");
  const updateMessage = document.querySelector("#update-message");
  const accessToken = new URLSearchParams(location.hash.slice(1)).get("access_token");
  const authorizationId = new URLSearchParams(location.search).get("authorization_id");
  if (accessToken) {
    requestPanel.classList.add("hidden");
    updatePanel.classList.remove("hidden");
    history.replaceState(null, "", location.pathname + location.search);
  }
  async function post(payload) {
    const response = await fetch("/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    return response.json();
  }
  requestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    requestMessage.textContent = "Sending reset link…";
    requestMessage.className = "";
    try {
      const email = new FormData(requestForm).get("email");
      const result = await post({ action: "request", email, authorization_id: authorizationId });
      requestMessage.textContent = result.message || "Check your email for a reset link.";
      requestMessage.className = "success";
    } catch {
      requestMessage.textContent = "Could not request a reset link. Try again shortly.";
      requestMessage.className = "error";
    }
  });
  updateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(updateForm);
    const password = String(values.get("password") || "");
    if (password !== String(values.get("confirmation") || "")) {
      updateMessage.textContent = "The passwords do not match.";
      updateMessage.className = "error";
      return;
    }
    updateMessage.textContent = "Updating password…";
    updateMessage.className = "";
    try {
      const result = await post({ action: "update", access_token: accessToken, password });
      if (!result.ok) throw new Error("update failed");
      updateMessage.textContent = "Password updated. You can now return to StockScout sign-in.";
      updateMessage.className = "success";
      updateForm.classList.add("hidden");
    } catch {
      updateMessage.textContent = "This reset link is invalid or expired. Request a new one.";
      updateMessage.className = "error";
    }
  });
})();`;
}

function sameOrigin(request: VercelRequest): boolean {
  const header = request.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  // Browser fetches supply Origin. Non-browser recovery clients may omit it;
  // that is safe here because the request response is non-enumerating and the
  // one-time reset token is still required before a password can be changed.
  return !origin || origin === publicOrigin();
}

function sendHtml(response: VercelResponse, status: number, content: string, type = "text/html; charset=utf-8"): void {
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", type);
  response.statusCode = status;
  response.end(content);
}

function sendJson(response: VercelResponse, status: number, value: object): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

async function requestReset(email: string, redirectTo: string): Promise<void> {
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) return;
  await client().auth.resetPasswordForEmail(email, { redirectTo });
}

async function updatePassword(accessToken: string, password: string): Promise<boolean> {
  if (!accessToken || password.length < 12 || password.length > 256) return false;
  const response = await fetch(`${requiredEnvironment("SUPABASE_URL")}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: requiredEnvironment("SUPABASE_PUBLISHABLE_KEY"),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  return response.ok;
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method === "GET" && query(request, "script") === "1") {
    sendHtml(response, 200, script(), "application/javascript; charset=utf-8");
    return;
  }
  if (request.method === "GET") {
    sendHtml(response, 200, page(request));
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    sendJson(response, 405, { ok: false });
    return;
  }
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false });
    return;
  }

  const payload = body(request);
  if (payload.action === "request") {
    const redirect = new URL("/password-reset", publicOrigin());
    const authorizationId = String(payload.authorization_id ?? "");
    if (AUTHORIZATION_ID.test(authorizationId)) redirect.searchParams.set("authorization_id", authorizationId);
    try {
      await requestReset(String(payload.email ?? "").trim(), redirect.toString());
    } catch {
      // Do not disclose whether an account exists or whether an email provider rejected it.
    }
    sendJson(response, 200, { ok: true, message: "If this address has a StockScout account, a reset link has been sent." });
    return;
  }
  if (payload.action === "update") {
    try {
      const ok = await updatePassword(String(payload.access_token ?? ""), String(payload.password ?? ""));
      sendJson(response, ok ? 200 : 400, { ok });
    } catch {
      sendJson(response, 400, { ok: false });
    }
    return;
  }
  sendJson(response, 400, { ok: false });
}
