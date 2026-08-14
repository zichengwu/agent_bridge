import { basename, resolve } from "node:path";

import type { ManagementStaticAsset } from "./management-http.js";

export const MANAGEMENT_DASHBOARD_STATIC_ROOT = resolve(
  import.meta.dirname,
  basename(import.meta.dirname) === "src"
    ? "../dist/management-dashboard-assets"
    : "management-dashboard-assets",
);

export const MANAGEMENT_DASHBOARD_STATIC_MANIFEST: readonly ManagementStaticAsset[] = Object.freeze(
  [
    Object.freeze({
      url_path: "/index.html",
      file_path: "index.html",
      media_type: "text/html; charset=utf-8",
      cache: "no-store",
    }),
    Object.freeze({
      url_path: "/assets/dashboard.807c5263.css",
      file_path: "dashboard.807c5263.css",
      media_type: "text/css; charset=utf-8",
      cache: "immutable",
    }),
    Object.freeze({
      url_path: "/assets/dashboard.d7edfe43.js",
      file_path: "dashboard.d7edfe43.js",
      media_type: "text/javascript; charset=utf-8",
      cache: "immutable",
    }),
  ],
);
