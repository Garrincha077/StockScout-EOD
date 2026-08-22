import type { IncomingMessage, ServerResponse } from "node:http";

import health from "./api/health.js";
import mcp from "./api/mcp.js";
import oauthConsent from "./api/oauth-consent.js";
import oauthProtectedResource from "./api/oauth-protected-resource.js";
import passwordReset from "./api/password-reset.js";

interface VercelRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(value: unknown): void;
}

function pathname(request: IncomingMessage): string {
  const host = request.headers.host ?? "stockscout-eod-mcp.vercel.app";
  return new URL(request.url ?? "/", `https://${host}`).pathname;
}

function adaptResponse(response: ServerResponse): VercelResponse {
  const adapted = response as VercelResponse;
  adapted.status = (code: number) => {
    adapted.statusCode = code;
    return adapted;
  };
  adapted.json = (value: unknown) => {
    if (!adapted.hasHeader("Content-Type")) {
      adapted.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    adapted.end(JSON.stringify(value));
  };
  return adapted;
}

async function hydrateBody(request: VercelRequest): Promise<void> {
  if (request.body !== undefined || !["POST", "PUT", "PATCH"].includes(request.method ?? "")) {
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    request.body = {};
    return;
  }
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      request.body = JSON.parse(raw);
      return;
    } catch {
      // Let the endpoint return its normal validation error for malformed JSON.
    }
  }
  request.body = raw;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function canonicalDocument(path: string, response: VercelResponse): boolean {
  const match = /^\/scans\/([^/]+)\/candidates\/([A-Z0-9._-]{1,20})$/.exec(path);
  if (!match) return false;
  let runId: string;
  try {
    runId = decodeURIComponent(match[1] ?? "");
  } catch {
    response.status(400).json({ error: "invalid_scan_id" });
    return true;
  }
  const ticker = match[2] ?? "";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.statusCode = 200;
  response.end(`<!doctype html><meta charset="utf-8"><title>StockScout scan record</title><main><h1>StockScout ${escapeHtml(ticker)}</h1><p>Scan ${escapeHtml(runId)}; prices are not live.</p><p>This is a private citation target. Open the StockScout app in ChatGPT and use fetch for the complete authenticated record.</p></main>`);
  return true;
}

export const config = { maxDuration: 30 };

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  response = adaptResponse(response);
  const path = pathname(request);
  if (canonicalDocument(path, response)) return;
  try {
    await hydrateBody(request);
  } catch {
    response.status(413).json({ error: "request_body_too_large" });
    return;
  }
  switch (path) {
    case "/":
    case "/health":
    case "/api/health":
      health(request, response);
      return;
    case "/.well-known/oauth-protected-resource":
    case "/.well-known/oauth-protected-resource/mcp":
    case "/api/oauth-protected-resource":
      oauthProtectedResource(request, response);
      return;
    case "/oauth/consent":
    case "/api/oauth-consent":
      await oauthConsent(request, response);
      return;
    case "/password-reset":
    case "/api/password-reset":
      await passwordReset(request, response);
      return;
    case "/mcp":
    case "/api/mcp":
      await mcp(request, response);
      return;
    default:
      response.status(404).json({ error: "not_found" });
  }
}
