import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MANAGEMENT_DASHBOARD_STATIC_MANIFEST,
  MANAGEMENT_DASHBOARD_STATIC_ROOT,
} from "../../../src/management-static-manifest.js";

describe("Slice E formal management page contract", () => {
  it("UX-001/002/012 固定页面包含摘要、三泳道和历史列表且没有任务创建入口", async () => {
    const html = await asset("index.html");
    expect(html).toContain("本次会话");
    expect(html).toContain("今日");
    expect(html).toContain("最近 7 天");
    expect(html).toContain("运行中");
    expect(html).toContain("待审批");
    expect(html).toContain("异常");
    expect(html).toContain("全部任务");
    expect(html).not.toMatch(/<button[^>]*>\s*创建任务|data-action=["']create/u);
    expect(await asset("dashboard.d7edfe43.js")).not.toContain("bridge_create_task");
  });

  it("UX-003/004/005/006/007/008 页面覆盖详情、阶段、未上报、拒绝和二次确认语义", async () => {
    const html = await asset("index.html");
    const client = await asset("dashboard.d7edfe43.js");
    expect(html).toContain("任务上下文");
    expect(html).toContain("最近事件");
    expect(html).toContain("拒绝时必须填写反馈");
    expect(html).toContain("需要二次确认");
    expect(client).toContain("— / 未上报");
    expect(client).toContain("preparing_context");
    expect(client).toContain("waiting_approval");
    expect(html).not.toContain("<progress");
    expect(client).toContain("stageOrder");
    expect(client).toContain("stage-strip");
  });

  it("OPS-005 固定 manifest 只交付 no-store HTML 与真实内容哈希 JS/CSS", async () => {
    expect(MANAGEMENT_DASHBOARD_STATIC_MANIFEST).toEqual([
      {
        url_path: "/index.html",
        file_path: "index.html",
        media_type: "text/html; charset=utf-8",
        cache: "no-store",
      },
      {
        url_path: "/assets/dashboard.807c5263.css",
        file_path: "dashboard.807c5263.css",
        media_type: "text/css; charset=utf-8",
        cache: "immutable",
      },
      {
        url_path: "/assets/dashboard.d7edfe43.js",
        file_path: "dashboard.d7edfe43.js",
        media_type: "text/javascript; charset=utf-8",
        cache: "immutable",
      },
    ]);
    for (const file of ["dashboard.807c5263.css", "dashboard.d7edfe43.js"]) {
      const content = await readFile(resolve(MANAGEMENT_DASHBOARD_STATIC_ROOT, file));
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
      expect(file).toContain(`.${hash}.`);
    }
  });

  it("OPS-008/010/UX-010/011 资产无远程资源、持久化、危险 DOM sink 或敏感样例", async () => {
    const all = [
      await asset("index.html"),
      await asset("dashboard.807c5263.css"),
      await asset("dashboard.d7edfe43.js"),
    ].join("\n");
    expect(all).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)|@import|sourceMappingURL|serviceWorker/u);
    expect(all).not.toMatch(
      /localStorage|sessionStorage|indexedDB|innerHTML|outerHTML|insertAdjacentHTML/u,
    );
    expect(all).not.toMatch(
      /\bsk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9]|\/Users\/|driver_payload|output\.delta/u,
    );
    expect(all).not.toContain("style=");
  });
});

async function asset(file: string): Promise<string> {
  return readFile(resolve(MANAGEMENT_DASHBOARD_STATIC_ROOT, file), "utf8");
}
