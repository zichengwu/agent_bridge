import * as sdk from "@cline/sdk";

export interface ClineCoreCreateOptions {
  backendMode: "hub" | "local";
  clientName: string;
  distinctId: string;
  hub?: {
    authToken?: string;
    cwd: string;
    endpoint?: string;
    strategy: "require-hub";
    workspaceRoot: string;
  };
}

export interface ClineCoreRuntime {
  readonly runtimeAddress?: string;
  dispose(reason?: string): Promise<void>;
  getAccumulatedUsage(sessionId: string): Promise<unknown>;
  list(limit?: number): Promise<unknown[]>;
  subscribe(listener: (event: unknown) => void): () => void;
}

export interface ClineCoreFactory {
  readonly prototype: Record<string, unknown>;
  create(options: ClineCoreCreateOptions): Promise<ClineCoreRuntime>;
}

const publicSurface = sdk as unknown as Record<string, unknown>;
const runtimeCore = publicSurface.ClineCore;
const buildVersion = publicSurface.CORE_BUILD_VERSION;

if (typeof runtimeCore !== "function") {
  throw new TypeError("@cline/sdk did not export ClineCore at runtime");
}

if (typeof buildVersion !== "string") {
  throw new TypeError("@cline/sdk did not export CORE_BUILD_VERSION at runtime");
}

// 0.0.65 的聚合声明在 typed ESLint 中会退化为 error type。Driver 只在此处
// 绑定经过运行时校验的 SDK 导出，其余代码依赖本地窄接口和协议层类型。
export const ClineCore = runtimeCore as unknown as ClineCoreFactory;
export const CORE_BUILD_VERSION = buildVersion;
