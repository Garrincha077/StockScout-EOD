import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";

import { EDGE_API_SCHEMA, lookupSingleOwner } from "./database.ts";

Deno.test("owner lookup targets the exposed API schema", async () => {
  const calls: string[] = [];
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const database = {
    schema(schemaName: string) {
      calls.push(`schema:${schemaName}`);
      return {
        async rpc(functionName: string) {
          calls.push(`rpc:${functionName}`);
          return { data: ownerId, error: null };
        },
      };
    },
  };

  assertEquals(await lookupSingleOwner(database), ownerId);
  assertEquals(EDGE_API_SCHEMA, "stockscout_api");
  assertEquals(calls, [
    "schema:stockscout_api",
    "rpc:eod_edge_single_owner_id",
  ]);
});

Deno.test("owner lookup fails closed on RPC error", async () => {
  const database = {
    schema(_schemaName: string) {
      return {
        async rpc(_functionName: string) {
          return { data: null, error: { message: "permission denied" } };
        },
      };
    },
  };

  await assertRejects(
    () => lookupSingleOwner(database),
    Error,
    "owner lookup failed: permission denied",
  );
});

Deno.test("owner lookup fails closed on malformed owner identity", async () => {
  const database = {
    schema(_schemaName: string) {
      return {
        async rpc(_functionName: string) {
          return { data: "not-a-uuid", error: null };
        },
      };
    },
  };

  await assertRejects(
    () => lookupSingleOwner(database),
    Error,
    "owner lookup returned an invalid UUID",
  );
});
