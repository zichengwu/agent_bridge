import { resolve } from "node:path";

import type { ManagementStaticAsset } from "./management-http.js";

// Slice E will add compiled, content-hashed browser assets to this fixed directory and manifest.
// Keeping the manifest empty in Slice C prevents an accidental source/config fallback.
export const MANAGEMENT_DASHBOARD_STATIC_ROOT = resolve(
  import.meta.dirname,
  "management-dashboard-assets",
);

export const MANAGEMENT_DASHBOARD_STATIC_MANIFEST: readonly ManagementStaticAsset[] = Object.freeze(
  [],
);
