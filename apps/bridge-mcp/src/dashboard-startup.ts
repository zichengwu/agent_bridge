import { execFile } from "node:child_process";

import { bootstrapBridgeApplication, type BridgeApplication } from "./bootstrap.js";
import { controlError } from "./errors.js";
import {
  startManagementHttpServer,
  type ManagementHttpAuditEvent,
  type StartedManagementHttpServer,
} from "./management-http.js";
import { ManagementSseService, type ManagementEventStream } from "./management-sse.js";
import {
  MANAGEMENT_DASHBOARD_STATIC_MANIFEST,
  MANAGEMENT_DASHBOARD_STATIC_ROOT,
} from "./management-static-manifest.js";

export type BrowserOpener = (launchUrl: string) => Promise<void>;

export interface BridgeDashboardOptions {
  readonly opener?: BrowserOpener;
  readonly event_stream?: ManagementEventStream;
  readonly audit?: (event: ManagementHttpAuditEvent) => void;
  readonly bootstrap?: (configPath: string) => Promise<BridgeApplication>;
  readonly start_http?: typeof startManagementHttpServer;
}

export interface BridgeDashboard {
  readonly origin: string;
  readonly application: BridgeApplication;
  close(): Promise<void>;
}

export async function startBridgeDashboard(
  configPath: string,
  options: BridgeDashboardOptions,
): Promise<BridgeDashboard> {
  const bootstrap = options.bootstrap ?? bootstrapBridgeApplication;
  const startHttp = options.start_http ?? startManagementHttpServer;
  const opener = options.opener ?? openDefaultBrowser;
  const application = await bootstrap(configPath);
  const eventStream =
    options.event_stream ??
    new ManagementSseService({
      fanout: application.events,
      get_current_cursor: () => application.management_projection.getCurrentCursor(),
      server_instance_id: application.server_instance_id,
    });
  let http: StartedManagementHttpServer | undefined;
  try {
    http = await startHttp({
      projection: application.management_projection,
      commands: application.management_commands,
      server_instance_id: application.server_instance_id,
      server_started_at: application.server_started_at,
      timezone: application.timezone,
      static_root: MANAGEMENT_DASHBOARD_STATIC_ROOT,
      static_manifest: MANAGEMENT_DASHBOARD_STATIC_MANIFEST,
      event_stream: eventStream,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    });
    const launchSecret = http.activateLaunchSecret();
    const launchUrl = `${http.origin}/#launch_secret=${launchSecret}`;
    try {
      await opener(launchUrl);
    } catch {
      throw controlError("DASHBOARD_OPEN_FAILED");
    }
    let closed = false;
    return Object.freeze({
      origin: http.origin,
      application,
      close: async () => {
        if (closed) return;
        closed = true;
        http?.stopAcceptingWrites();
        await http?.close();
        await application.close();
      },
    });
  } catch (error) {
    http?.revokeLaunchSecret();
    http?.stopAcceptingWrites();
    await http?.close().catch(() => undefined);
    await application.close().catch(() => undefined);
    throw error;
  }
}

export async function openDefaultBrowser(launchUrl: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("/usr/bin/open", [launchUrl], { windowsHide: true }, (error) => {
      if (error === null) resolvePromise();
      else reject(new Error("Default browser opener failed", { cause: error }));
    });
  });
}
