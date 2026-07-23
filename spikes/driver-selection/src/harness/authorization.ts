import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { assertFreshPriceSnapshot, type ProviderPriceSnapshot } from "./provider-policy.js";

export const AUTHORIZATION_VALUE = "1";
export const BUDGET_CONFIRMATION = "CONFIRM $0.24";
export const SINGLE_BUDGET_CONFIRMATION = "CONFIRM $0.12";

export type RealBLayerCommand = "opencode:b" | "claude:b" | "b:collaboration";

export interface AuthorizationPreconditions {
  authorizedValue?: string;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
}

export interface RealProviderAuthorization {
  credentials: Buffer[];
  totalBudgetUsd: 0.12 | 0.24;
}

export function validateAuthorizationPreconditions(input: AuthorizationPreconditions): void {
  if (input.authorizedValue !== AUTHORIZATION_VALUE) {
    throw new Error("B_LAYER_AUTHORIZED_REQUIRED");
  }
  if (!input.stdinIsTTY || !input.stderrIsTTY) {
    throw new Error("B_LAYER_TTY_REQUIRED");
  }
}

export async function requestRealProviderAuthorization(
  command: RealBLayerCommand,
  priceSnapshot: ProviderPriceSnapshot,
): Promise<RealProviderAuthorization> {
  validateAuthorizationPreconditions({
    authorizedValue: process.env.B_LAYER_AUTHORIZED,
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  });
  assertFreshPriceSnapshot(priceSnapshot);

  const reader = createInterface({ input: process.stdin, output: process.stderr });
  const collaboration = command === "b:collaboration";
  const expectedConfirmation = collaboration ? BUDGET_CONFIRMATION : SINGLE_BUDGET_CONFIRMATION;
  const confirmation = await reader.question(
    `价格快照 ${priceSnapshot.checkedAt}：输入 ${expectedConfirmation} 以确认应用层费用上限：`,
  );
  reader.close();
  if (confirmation !== expectedConfirmation) {
    throw new Error("B_LAYER_BUDGET_CONFIRMATION_REQUIRED");
  }

  const credentials: Buffer[] = [];
  try {
    credentials.push(
      ...(await readSecretsFromTty(
        process.stdin,
        process.stderr,
        collaboration
          ? [
              "输入候选一的一次性 DeepSeek Key（不回显）：",
              "输入候选二的不同一次性 DeepSeek Key（不回显）：",
            ]
          : ["输入候选一的一次性 DeepSeek Key（不回显）："],
      )),
    );
    validateCredentialSet(credentials, collaboration ? 2 : 1);
    return { credentials, totalBudgetUsd: collaboration ? 0.24 : 0.12 };
  } catch (error) {
    for (const credential of credentials) credential.fill(0);
    throw error;
  }
}

export function validateCredentialSet(credentials: Buffer[], expectedCount: 1 | 2): void {
  if (credentials.length !== expectedCount) throw new Error("B_LAYER_CREDENTIAL_COUNT_INVALID");
  if (credentials.some((credential) => credential.length < 8)) {
    throw new Error("B_LAYER_CREDENTIAL_INVALID");
  }
  if (credentials.length === 2 && credentials[0]!.equals(credentials[1]!)) {
    throw new Error("B_LAYER_DISTINCT_CREDENTIALS_REQUIRED");
  }
}

export function clearAuthorization(authorization: RealProviderAuthorization): void {
  for (const credential of authorization.credentials) credential.fill(0);
}

type SecretInput = Readable & {
  setRawMode?: (enabled: boolean) => void;
  unref?: () => void;
};

export async function readSecretsFromTty(
  input: SecretInput,
  output: Pick<Writable, "write">,
  prompts: readonly [string, ...string[]],
): Promise<Buffer[]> {
  output.write(prompts[0]);
  input.setRawMode?.(true);
  input.resume();
  const bytes: number[] = [];
  const credentials: Buffer[] = [];
  let skipLineFeed = false;

  try {
    for await (const chunk of input.iterator({ destroyOnReturn: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      for (const byte of data) {
        if (skipLineFeed && byte === 10) {
          skipLineFeed = false;
          continue;
        }
        skipLineFeed = false;
        if (byte === 3) {
          throw new Error("B_LAYER_CREDENTIAL_CANCELLED");
        }
        if (byte === 10 || byte === 13) {
          output.write("\n");
          credentials.push(Buffer.from(bytes));
          bytes.fill(0);
          bytes.length = 0;
          skipLineFeed = byte === 13;
          if (credentials.length === prompts.length) return credentials;
          output.write(prompts[credentials.length]!);
          continue;
        }
        if (byte === 8 || byte === 127) {
          bytes.pop();
        } else {
          bytes.push(byte);
        }
      }
    }
    throw new Error("B_LAYER_CREDENTIAL_INPUT_CLOSED");
  } catch (error) {
    bytes.fill(0);
    for (const credential of credentials) credential.fill(0);
    throw error;
  } finally {
    input.setRawMode?.(false);
    input.pause();
    input.unref?.();
  }
}
