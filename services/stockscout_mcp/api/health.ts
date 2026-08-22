import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(
  _request: IncomingMessage,
  response: ServerResponse & {
    status(code: number): ServerResponse & { json(value: unknown): void };
    json(value: unknown): void;
  },
): void {
  response.status(200).json({
    service: "stockscout-mcp",
    version: "1.0.0",
    mode: "tool-only",
    broker_socket: false,
    market_transmit_capability: false,
  });
}
