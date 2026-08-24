export const EDGE_API_SCHEMA = "stockscout_api";

type RpcError = { message?: string } | null;

type SchemaRpcClient = {
  rpc: (
    functionName: string,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

type DatabaseClient = {
  schema: (schemaName: string) => SchemaRpcClient;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function lookupSingleOwner(
  database: DatabaseClient,
): Promise<string> {
  const response = await database
    .schema(EDGE_API_SCHEMA)
    .rpc("eod_edge_single_owner_id");
  if (response.error) {
    throw new Error(
      `owner lookup failed: ${response.error.message ?? "database error"}`,
    );
  }
  const ownerId = String(response.data ?? "");
  if (!UUID_PATTERN.test(ownerId)) {
    throw new Error("owner lookup returned an invalid UUID");
  }
  return ownerId;
}
