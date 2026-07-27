import { describe, expect, it } from "vitest";

import {
  canonicalizeDomainJson,
  computeContentHash,
  computeDocumentContentHash,
  hasValidDocumentContentHash,
  isDomainJsonValue,
  scanSensitiveContent,
} from "../src/index.js";

describe("纯 JSON 内容完整性", () => {
  it("对象键顺序不影响规范 JSON 与 SHA-256", () => {
    const left = { z: 1, nested: { b: true, a: [2, null] } };
    const right = { nested: { a: [2, null], b: true }, z: 1 };

    expect(canonicalizeDomainJson(left)).toBe(canonicalizeDomainJson(right));
    expect(computeContentHash(left)).toBe(computeContentHash(right));
    expect(computeContentHash(left)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("数组顺序参与内容哈希", () => {
    expect(computeContentHash(["a", "b"])).not.toBe(computeContentHash(["b", "a"]));
  });

  it("文档哈希排除 content_hash 自身", () => {
    const payload = { id: "document-1", nested: { stable: true } };
    const document = { ...payload, content_hash: computeContentHash(payload) };

    expect(computeDocumentContentHash(document)).toBe(document.content_hash);
    expect(hasValidDocumentContentHash(document)).toBe(true);
    expect(hasValidDocumentContentHash({ ...document, id: "document-2" })).toBe(false);
  });

  it("敏感字段、完整 transcript 和模型内部思考返回稳定路径与规则", () => {
    const findings = scanSensitiveContent({
      nested: {
        api_key: "redacted",
        transcript: [],
        internal_reasoning: "redacted",
      },
    });

    expect(findings).toEqual([
      { path: "/nested/api_key", rule: "CREDENTIAL_FIELD" },
      { path: "/nested/internal_reasoning", rule: "INTERNAL_REASONING_FIELD" },
      { path: "/nested/transcript", rule: "FULL_TRANSCRIPT_FIELD" },
    ]);
  });

  it.each([
    "Bearer abcdefghijklmnop",
    "sk-abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----",
    "AKIA1234567890ABCDEF",
  ])("识别高置信凭据模式但不返回命中值", (secret) => {
    const findings = scanSensitiveContent({ value: secret });

    expect(findings).toEqual([{ path: "/value", rule: "CREDENTIAL_PATTERN" }]);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("普通 Token 用量和哈希字段不会误报为凭据", () => {
    expect(
      scanSensitiveContent({
        used_tokens: 700,
        max_tokens: 1000,
        content_hash: `sha256:${"a".repeat(64)}`,
      }),
    ).toEqual([]);
  });

  it.each(["client_secret", "auth-token", "refreshToken", "databasePassword"])(
    "识别常见派生凭据字段 %s",
    (field) => {
      expect(scanSensitiveContent({ [field]: "redacted" })).toEqual([
        { path: `/${field}`, rule: "CREDENTIAL_FIELD" },
      ]);
    },
  );

  it("只接受有限、无环的纯 JSON 值", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(isDomainJsonValue({ valid: [true, 1, "value", null] })).toBe(true);
    expect(isDomainJsonValue({ invalid: undefined })).toBe(false);
    expect(isDomainJsonValue(new Date())).toBe(false);
    expect(isDomainJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isDomainJsonValue(circular)).toBe(false);
  });
});
