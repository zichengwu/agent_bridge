import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");
const sourceRoot = resolve(packageRoot, "src", "management-dashboard-assets");
const outputRoot = resolve(packageRoot, "dist", "management-dashboard-assets");

const files = ["index.html", "dashboard.807c5263.css"];

await mkdir(outputRoot, { recursive: true });
await Promise.all(
  files.map((file) => copyFile(resolve(sourceRoot, file), resolve(outputRoot, file))),
);

const html = await readFile(resolve(sourceRoot, "index.html"), "utf8");
for (const asset of ["dashboard.807c5263.css", "dashboard.d7edfe43.js"]) {
  if (!html.includes(`/assets/${asset}`)) {
    throw new Error(`Dashboard asset reference missing: ${asset}`);
  }
  const content = await readFile(resolve(outputRoot, asset));
  const expectedHash = asset.split(".")[1];
  const actualHash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  if (actualHash !== expectedHash) {
    throw new Error(`Dashboard asset hash mismatch: ${asset}`);
  }
}
