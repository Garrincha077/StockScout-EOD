import { jcsStringify, type JsonObject, publishRecordHash } from "./jcs.ts";
import fixtureJson from "./jcs_fixture.json" with { type: "json" };

Deno.test(
  "publish wrapper hash matches the cross-language JCS fixture",
  async () => {
    const fixture = fixtureJson as {
      wrapper: JsonObject;
      canonical: string;
      sha256: string;
    };
    if (jcsStringify(fixture.wrapper) !== fixture.canonical) {
      throw new Error("JCS canonical form does not match the shared fixture");
    }
    if (await publishRecordHash(fixture.wrapper) !== fixture.sha256) {
      throw new Error("publish wrapper hash does not match the shared fixture");
    }
  },
);
