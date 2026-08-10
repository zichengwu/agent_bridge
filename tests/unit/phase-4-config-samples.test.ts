import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseTaskVersion } from "@agent-bridge/schemas";
import { describe, expect, it } from "vitest";

describe("Phase 4 正式角色配置样例", () => {
  it("公开运行时 JSON Schema 本身是有效 JSON 且禁止附加字段", async () => {
    const schemaPath = resolve(process.cwd(), "config/agent-bridge.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toHaveProperty("drivers");
  });

  it.each(["developer", "tester", "reviewer"])(
    "%s 样例是完整且哈希有效的 TaskVersion",
    async (role) => {
      const path = resolve(process.cwd(), `config/task-contracts/${role}.example.json`);
      const contract = parseTaskVersion(JSON.parse(await readFile(path, "utf8")));

      expect(contract.role).toBe(role);
      expect(contract.context_policy.inherit_full_transcript).toBe(false);
      expect(contract.scope.deny).toContain(".env*");
    },
  );
});
