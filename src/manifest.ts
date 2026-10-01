import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { resolveHttpBase, settings } from "./config.js";
import { rawFetch } from "./net.js";
import { SDK_VERSION } from "./version.js";
import type { ManifestWire } from "./types.js";

/**
 * Service manifest: one best-effort HTTP POST per process describing this
 * service (framework, runtime, dependency inventory from the nearest
 * package.json). The server turns it into the project's service catalog.
 * Failures are silent — tracing never depends on the manifest reaching the
 * server. Mirrors the fleet's manifest wire format.
 */

/** Well-known frameworks, checked in priority order; the first match wins. */
const KNOWN_FRAMEWORKS: readonly [pkg: string, name: string][] = [
  ["express", "express"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["next", "next"],
  ["@nestjs/core", "nestjs"],
];

/** Caps the reported dependency list; the server enforces the same limit. */
export const MAX_DEPS = 500;

export interface PackageInfo {
  dependencies: Record<string, string>;
}

/**
 * Detects the web framework from a dependency map — first match in
 * KNOWN_FRAMEWORKS order wins; everything else reports as "".
 */
export function detectFramework(dependencies: Record<string, string> | undefined): string {
  if (!dependencies) return "";
  for (const [pkg, name] of KNOWN_FRAMEWORKS) {
    if (Object.prototype.hasOwnProperty.call(dependencies, pkg)) return name;
  }
  return "";
}

/**
 * Reads the nearest package.json, walking up from startDir (cwd by
 * default). Returns null when none exists.
 */
export function readNearestPackageJson(startDir: string = process.cwd()): PackageInfo | null {
  let dir = resolve(startDir);
  for (;;) {
    try {
      const raw = readFileSync(resolve(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as Partial<PackageInfo>;
      return { dependencies: parsed.dependencies ?? {} };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/**
 * Builds the manifest body. `pkg` is injectable for tests; production uses
 * the nearest package.json (production dependencies only, sorted, capped).
 */
export function buildManifest(serviceName: string, pkg: PackageInfo | null = readNearestPackageJson()): ManifestWire {
  const deps: { name: string; version: string }[] = [];
  if (pkg?.dependencies) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      deps.push({ name, version: String(version) });
    }
  }
  deps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  deps.length = Math.min(deps.length, MAX_DEPS);

  const s = settings();
  return {
    service_name: serviceName || s.serviceName,
    language: "node",
    sdk_version: SDK_VERSION,
    runtime_version: process.version,
    framework: detectFramework(pkg?.dependencies),
    os_arch: `${process.platform}/${process.arch}`,
    app_version: process.env["DATAFLOW_APP_VERSION"] ?? "",
    dependencies: deps,
  };
}

let manifestSent = false;

/**
 * Reports the service manifest once per process. Best-effort: short
 * timeout, silent failures, fire-and-forget so startup is never delayed.
 */
export function sendManifest(): void {
  if (manifestSent) return;
  manifestSent = true;
  const s = settings();
  const base = resolveHttpBase();
  if (base === null || !s.apiKey) {
    manifestSent = false; // retryable when configuration completes later
    return;
  }
  const body = JSON.stringify(buildManifest(s.serviceName));
  // rawFetch: never instrumentHttp's wrapped fetch — manifest reporting
  // must not trace itself.
  void rawFetch(`${base}/api/v1/manifest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": s.apiKey },
    body,
    signal: AbortSignal.timeout(5000),
  }).then(
    (resp) => void resp.arrayBuffer().catch(() => {}),
    () => {}, // manifest reporting is best-effort
  );
}

/** Test seam. */
export function _resetManifestForTests(): void {
  manifestSent = false;
}
