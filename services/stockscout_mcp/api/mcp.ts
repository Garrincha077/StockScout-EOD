import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import { authenticate } from "../src/auth.js";
import { withEodScanFallback } from "../src/eodScanPatch.js";
import { AuthenticationError, oauthChallenge } from "../src/oauth.js";
import { SupabaseStockScoutRepository } from "../src/repository.js";
import { createStockScoutServer } from "../src/mcpServer.js";

interface VercelRequest extends IncomingMessage {
  body?: unknown;
}

interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(value: unknown): void;
}

function authorizationHeader(request: VercelRequest): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
    return;
  }

  try {
    const context = await authenticate(authorizationHeader(request));
    const legacyRepository = new SupabaseStockScoutRepository(
      context.database,
      context.userId,
    );
    const repository = withEodScanFallback(legacyRepository, context.database);
    const server = createStockScoutServer(repository);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      const unauthorized = error instanceof AuthenticationError;
      if (unauthorized) {
        response.setHeader("WWW-Authenticate", oauthChallenge());
      }
      const message = unauthorized ? "Unauthorized" : "Internal server error";
      const status = unauthorized ? 401 : 500;
      response.status(status).json({
        jsonrpc: "2.0",
        error: { code: -32603, message },
        id: null,
      });
    }
  }
}
