import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { DriverTransportError, readJsonLines, writeJsonLine } from "../src/index.js";

describe("Driver Transport JSONL codec", () => {
  it("跨 chunk 读取 LF/CRLF，并接受最后一行无换行", async () => {
    const stream = Readable.from(['{"a":', '1}\r\n{"b":2}\n', '{"c":3}']);
    const values: unknown[] = [];
    for await (const value of readJsonLines(stream)) {
      values.push(value);
    }
    expect(values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it.each([
    ["empty line", "\n", 100],
    ["invalid JSON", "{invalid}\n", 100],
    ["oversized line", `${"x".repeat(11)}\n`, 10],
  ])("拒绝 %s", async (_label, source, limit) => {
    const consume = async () => {
      for await (const value of readJsonLines(Readable.from([source]), limit)) {
        void value;
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(DriverTransportError);
  });

  it("按单行 JSON 写入并支持 backpressure 通道", async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    await writeJsonLine(stream, { ok: true });
    stream.end();
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"ok":true}\n');
  });

  it("拒绝 JSON.stringify 不会产生字符串的值", async () => {
    await expect(writeJsonLine(new PassThrough(), undefined)).rejects.toMatchObject({
      code: "DRIVER_TRANSPORT_MESSAGE_INVALID",
    });
  });
});
