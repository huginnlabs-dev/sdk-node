import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import { resolveHttpBase } from "./config.js";

/**
 * Static route scanner: extract declared HTTP endpoints from JS/TS source
 * with regex line scanning (no AST dependencies, scanned code is never
 * imported or executed) and post them to the Dataflow service catalog
 * (POST {base}/api/v1/catalog, the WS3 contract). Express (including
 * router-level use() prefixes, one level), Fastify (flat) and Koa are
 * covered by their method-call shape; NestJS via its decorators. Hapi is
 * intentionally not supported. Mirrors the fleet's scan CLIs.
 */

export const CATALOG_PATH = "/api/v1/catalog";
export const MAX_ROUTES = 1000; // server-enforced limit; mirrored client-side
const HTTP_TIMEOUT_MS = 10_000;

const SKIP_DIRS = new Set(["node_modules", "dist", "build"]);

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);

/** Matches `app.get("/p"` — any object, the six route verbs, quoted path. */
const ROUTE_CALL_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*(['"`])((?:\\.|(?!\3).)*)\3/g;

/** Matches `app.use("/base", router)` — one-level mount prefixes. */
const USE_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*,\s*([A-Za-z_$][\w$]*)\b(?![.(])/;

/** Matches `@Controller('base')` — the class prefix for NestJS routes. */
const CONTROLLER_RE = /@\s*Controller\s*\(\s*(?:(['"`])((?:\\.|(?!\1).)*)\1)?/;

/** Matches `@Get('p')` — the NestJS method decorators. */
const NEST_METHOD_RE = /@\s*(Get|Post|Put|Delete|Patch|All)\s*\(\s*(?:(['"`])((?:\\.|(?!\2).)*)\2)?\s*\)/g;

export interface ScannedRoute {
  method: string;
  path: string;
  handler: string;
  source_file: string;
}

export interface ScanResult {
  routes: ScannedRoute[];
  files_scanned: number;
  parse_errors: number;
}

export interface CatalogBody {
  service_name: string;
  routes: { method: string; path: string; handler: string; source_file: string }[];
}

interface LooseRoute {
  method: string;
  path: string;
  handler: string;
}

/**
 * Extracts (method, path, handler) declarations from one source string.
 * Lines are scanned with regexes; anything that cannot be read as a
 * literal route declaration is skipped — false negatives are fine,
 * false positives are not.
 */
export function extractRoutes(source: string): LooseRoute[] {
  const lines = source.split(/\r?\n/);
  const out: LooseRoute[] = [];
  const mounts = new Map<string, string>(); // one-level router mounts, first wins
  let controllerBase = ""; // NestJS @Controller prefix in effect

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

    const ctrl = CONTROLLER_RE.exec(line);
    if (ctrl !== null) {
      controllerBase = ctrl[2] ?? "";
    }

    const use = USE_RE.exec(line);
    if (use !== null && use[3] !== undefined && use[4] !== undefined) {
      mounts.set(use[4], use[3]);
    }

    for (const m of line.matchAll(ROUTE_CALL_RE)) {
      const objectName = m[1] ?? "";
      const verb = (m[2] ?? "").toUpperCase();
      const path = m[4] ?? "";
      const rest = line.slice((m.index ?? 0) + m[0].length);
      out.push({
        method: verb === "ALL" ? "ANY" : verb,
        path: joinPrefix(mounts.get(objectName) ?? "", path),
        handler: callHandler(rest, lines, i),
      });
    }

    for (const m of line.matchAll(NEST_METHOD_RE)) {
      const verb = (m[1] ?? "").toUpperCase();
      const path = m[3] !== undefined && m[3] !== "" ? m[3] : "/";
      const rest = line.slice((m.index ?? 0) + m[0].length);
      out.push({
        method: verb === "ALL" ? "ANY" : verb,
        path: nestPath(controllerBase, path),
        handler: nestHandler(rest, lines, i),
      });
    }
  }
  return out;
}

/**
 * Extracts routes from every scannable file under root. Routes are deduped
 * on (method, path) — first declaration wins — and sorted by (source file,
 * path, method, handler) for deterministic output. Unreadable files are
 * counted and skipped, never fatal: scanning foreign source must stay
 * best-effort.
 */
export function scanDirectory(root: string): ScanResult {
  const absRoot = resolve(root);
  const result: ScanResult = { routes: [], files_scanned: 0, parse_errors: 0 };
  const seen = new Set<string>();
  for (const file of walk(absRoot)) {
    result.files_scanned += 1;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      result.parse_errors += 1;
      continue;
    }
    const sourceFile = relative(absRoot, file).split(sep).join("/");
    for (const route of extractRoutes(source)) {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.routes.push({ ...route, source_file: sourceFile });
    }
  }
  result.routes.sort((a, b) =>
    a.source_file !== b.source_file
      ? a.source_file < b.source_file
        ? -1
        : 1
      : a.path !== b.path
        ? a.path < b.path
          ? -1
          : 1
        : a.method !== b.method
          ? a.method < b.method
            ? -1
            : 1
          : a.handler < b.handler
            ? -1
            : a.handler > b.handler
              ? 1
              : 0,
  );
  return result;
}

function* walk(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && isScannable(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function isScannable(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  if (!SOURCE_EXTENSIONS.has(name.slice(dot))) return false;
  return !/\.(test|spec)\./.test(name);
}

/** Applies a one-level router mount prefix ("x" + "/y" -> "x/y"). */
function joinPrefix(prefix: string, path: string): string {
  if (prefix === "") return path;
  let joined: string;
  if (path === "/") {
    joined = prefix === "/" ? "/" : prefix;
  } else if (path.startsWith("/")) {
    joined = prefix.endsWith("/") ? prefix + path.slice(1) : prefix + path;
  } else {
    joined = prefix.endsWith("/") ? prefix + path : `${prefix}/${path}`;
  }
  return joined.replace(/\/{2,}/g, "/");
}

/** Joins a NestJS @Controller base with the decorator path. */
function nestPath(base: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base === "") return p;
  const bare = base.replace(/^\//, "");
  return p === "/" ? `/${bare}` : joinPrefix("/", `${bare}${p}`);
}

/**
 * Handler for a `.verb("path"` call: a named function expression, a bare
 * handler reference on the same line, or a bare reference starting the
 * next line. Inline arrows and anonymous functions yield "".
 */
function callHandler(rest: string, lines: string[], idx: number): string {
  let m = /\bfunction\s+([A-Za-z_$][\w$]*)/.exec(rest);
  if (m !== null) return m[1] ?? "";
  if (/\bfunction\b|=>/.test(rest)) return "";
  m = /^\s*,\s*([A-Za-z_$][\w$]*)\s*\)?\s*;?\s*(?:\/\/.*)?$/.exec(rest);
  if (m !== null) return m[1] ?? "";
  for (let k = 1; k <= 2 && idx + k < lines.length; k += 1) {
    const next = (lines[idx + k] ?? "").trim();
    if (next === "") continue;
    m = /^([A-Za-z_$][\w$]*)\s*\)?\s*,?\s*;?$/.exec(next);
    return m !== null ? (m[1] ?? "") : "";
  }
  return "";
}

/** Handler for a NestJS method decorator: the method declared below it. */
function nestHandler(rest: string, lines: string[], idx: number): string {
  const m = /^\s*(?:[A-Za-z_$][\w$]*\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (m !== null) return m[1] ?? "";
  for (let k = 1; k <= 3 && idx + k < lines.length; k += 1) {
    const next = (lines[idx + k] ?? "").trim();
    if (next === "" || next.startsWith("@")) continue;
    const m2 = /^(?:[A-Za-z_$][\w$]*\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(next);
    return m2 !== null ? (m2[1] ?? "") : "";
  }
  return "";
}

export function buildBody(serviceName: string, routes: ScannedRoute[]): CatalogBody {
  return {
    service_name: serviceName,
    routes: routes.map((r) => ({
      method: r.method,
      path: r.path,
      handler: r.handler,
      source_file: r.source_file,
    })),
  };
}

/** POSTs the catalog body; throws on network errors and non-2xx. */
export async function postCatalog(base: string, apiKey: string, body: CatalogBody): Promise<void> {
  const resp = await fetch(`${base}${CATALOG_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status}`);
  }
  await resp.arrayBuffer().catch(() => {});
}

export interface CliFlags {
  dir: string;
  service: string;
  url: string;
  apiKey: string;
  print: boolean;
}

export function parseArgs(argv: string[]): { flags: CliFlags } | { error: string } {
  const flags: CliFlags = { dir: ".", service: "", url: "", apiKey: "", print: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    let name = arg;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    const takesValue = (): string | null => {
      if (value !== undefined) return value;
      const next = argv[i + 1];
      if (next === undefined) return null;
      i += 1;
      return next;
    };
    switch (name) {
      case "--dir": {
        const v = takesValue();
        if (v === null) return { error: "missing value for --dir" };
        flags.dir = v;
        break;
      }
      case "--service": {
        const v = takesValue();
        if (v === null) return { error: "missing value for --service" };
        flags.service = v;
        break;
      }
      case "--url": {
        const v = takesValue();
        if (v === null) return { error: "missing value for --url" };
        flags.url = v;
        break;
      }
      case "--api-key": {
        const v = takesValue();
        if (v === null) return { error: "missing value for --api-key" };
        flags.apiKey = v;
        break;
      }
      case "--print":
        flags.print = true;
        break;
      default:
        return { error: `unknown argument: ${arg}` };
    }
  }
  return { flags };
}

export interface MainStreams {
  out?: { write(s: string): void };
  err?: { write(s: string): void };
}

/**
 * The dataflow-scan entry point. Exit codes: 0 = ok (posted, printed, or
 * nothing to post), 1 = skip/scan error (bad --dir, bare host:port with no
 * derivable HTTP base, bad arguments), 2 = catalog POST failed (missing
 * API key, network error or non-2xx response).
 */
export async function main(argv: string[], streams: MainStreams = {}): Promise<number> {
  const out = streams.out ?? process.stdout;
  const err = streams.err ?? process.stderr;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    err.write(`dataflow-scan: ${parsed.error}\n`);
    return 1;
  }
  const flags = parsed.flags;

  const root = resolve(flags.dir);
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    err.write(`dataflow-scan: not a directory: ${flags.dir}\n`);
    return 1;
  }

  const service =
    flags.service.trim() || (process.env["DATAFLOW_SERVICE_NAME"] ?? "").trim() || basename(root);

  const result = scanDirectory(root);
  if (result.parse_errors > 0) {
    err.write(
      `dataflow-scan: warning: ${result.parse_errors} file(s) could not be read and were skipped\n`,
    );
  }
  err.write(
    `dataflow-scan: ${result.routes.length} routes across ${result.files_scanned} files under ${flags.dir}\n`,
  );

  let routes = result.routes;
  if (routes.length > MAX_ROUTES) {
    err.write(`dataflow-scan: warning: truncating to first ${MAX_ROUTES} routes (server limit)\n`);
    routes = routes.slice(0, MAX_ROUTES);
  }
  const body = buildBody(service, routes);

  if (flags.print) {
    out.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }

  if (routes.length === 0) {
    err.write("dataflow-scan: no routes found; nothing to post\n");
    return 0;
  }

  const flagUrl = flags.url.trim();
  const base = flagUrl !== "" ? flagUrl.replace(/\/+$/, "") : resolveHttpBase(
    process.env["DATAFLOW_ENDPOINT"] ?? "",
    process.env["DATAFLOW_HTTP_URL"] ?? "",
  );
  if (base === null) {
    err.write(
      "dataflow-scan: no HTTP endpoint derived from DATAFLOW_ENDPOINT (bare host:port has no " +
        "HTTP base). Re-run with --url or set DATAFLOW_HTTP_URL to post; results were NOT posted.\n",
    );
    return 1;
  }

  const apiKey = flags.apiKey || (process.env["DATAFLOW_API_KEY"] ?? "");
  if (apiKey === "") {
    err.write("dataflow-scan: no API key (--api-key or DATAFLOW_API_KEY); cannot post the catalog\n");
    return 2;
  }

  try {
    await postCatalog(base, apiKey, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.write(`dataflow-scan: POST ${base}${CATALOG_PATH} failed: ${msg}\n`);
    return 2;
  }

  err.write(`dataflow-scan: posted ${routes.length} route(s) to ${base}${CATALOG_PATH} (service: ${service})\n`);
  return 0;
}
