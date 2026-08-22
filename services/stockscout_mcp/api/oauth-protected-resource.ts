import type { IncomingMessage, ServerResponse } from "node:http";

import { protectedResourceMetadata } from "../src/oauth.js";

type VercelResponse = ServerResponse & {
  status(code: number): VercelResponse;
  json(value: unknown): void;
};

export default function handler(
  request: IncomingMessage,
  response: VercelResponse,
): void {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "method_not_allowed" });
    return;
  }
  response.setHeader("Cache-Control", "public, max-age=300");
  response.status(200).json(protectedResourceMetadata());
}
