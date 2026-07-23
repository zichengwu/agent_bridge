import { createReadStream } from "node:fs";

import type { RealGatewayPolicy } from "./provider-policy.js";
import { startRealProviderGatewayCore } from "./real-provider-gateway-core.js";

const credentialPromise = readCredential();
let gateway: Awaited<ReturnType<typeof startRealProviderGatewayCore>> | undefined;
let credential: Buffer | undefined;

process.on("message", (message: unknown) => {
  void handleMessage(message);
});

async function handleMessage(message: unknown): Promise<void> {
  const record = asRecord(message);
  if (record?.type === "start") {
    if (gateway !== undefined) throw new Error("REAL_GATEWAY_ALREADY_STARTED");
    credential = await credentialPromise;
    gateway = await startRealProviderGatewayCore({
      policy: record.policy as RealGatewayPolicy,
      credential,
    });
    process.send?.({ type: "ready", url: gateway.url });
    return;
  }
  if (record?.type === "audit") {
    process.send?.({ type: "audit", audit: gateway?.audit() });
    return;
  }
  if (record?.type === "close") {
    const audit = gateway?.audit();
    await gateway?.close();
    credential?.fill(0);
    process.send?.({ type: "closed", audit });
    process.disconnect();
  }
}

async function readCredential(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream("", {
    fd: 3,
    autoClose: true,
  }) as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  const result = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  if (result.length < 8) throw new Error("REAL_GATEWAY_CREDENTIAL_INVALID");
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
