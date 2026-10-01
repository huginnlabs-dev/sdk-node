import { hostname } from "node:os";

/**
 * SDK configuration: DATAFLOW_* environment plus an explicit configure().
 * Mirrors the fleet (Go config.go / Python config.py).
 */

export interface DataflowOptions {
  /** Authenticates the process against a SaaS project. */
  apiKey?: string;
  /** Ingestion address: "http(s)://host:port" or a bare gRPC "host:port". */
  endpoint?: string;
  /** Explicit HTTP API base (needed when endpoint is a bare host:port). */
  httpUrl?: string;
  /** Labels every event emitted by this process. */
  serviceName?: string;
  /** Enables client-side AES-256-GCM payload encryption when set. */
  encryptionKey?: string;
  /** Hex-encoded PBKDF2 salt; a fresh random 16-byte salt when unset. */
  salt?: string;
  /** Fraction of spans shipped, in [0,1]. Default 1. */
  sampleRatio?: number;
  /** Bounded in-memory buffer; oldest events dropped on overflow. */
  bufferSize?: number;
  /** Kill switch: no spans, no manifest, no network. */
  disabled?: boolean;
  /** Receives SDK diagnostics (defaults to console.warn). */
  logger?: (message: string) => void;
}

export interface Settings {
  apiKey: string;
  endpoint: string;
  httpUrl: string;
  serviceName: string;
  encryptionKey: string;
  salt: string;
  sampleRatio: number;
  bufferSize: number;
  disabled: boolean;
  logger: (message: string) => void;
}

const DEFAULT_ENDPOINT = "api.huginnlabs.com:9090";

function envStr(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

function envFloat(name: string, fallback: number): number {
  const raw = envStr(name);
  if (!raw) return fallback;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = envStr(name);
  if (!raw) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(envStr(name).toLowerCase());
}

/** Builds a Settings from the DATAFLOW_* environment. */
export function loadEnv(): Settings {
  return {
    apiKey: envStr("DATAFLOW_API_KEY"),
    endpoint: envStr("DATAFLOW_ENDPOINT") || DEFAULT_ENDPOINT,
    httpUrl: envStr("DATAFLOW_HTTP_URL"),
    serviceName: envStr("DATAFLOW_SERVICE_NAME") || hostname() || "unknown-service",
    encryptionKey: envStr("DATAFLOW_ENCRYPTION_KEY"),
    salt: envStr("DATAFLOW_SALT"),
    sampleRatio: envFloat("DATAFLOW_SAMPLE_RATIO", 1),
    bufferSize: envInt("DATAFLOW_BUFFER_SIZE", 10000),
    disabled: envBool("DATAFLOW_DISABLED"),
    logger: (message: string) => console.warn(`dataflow: ${message}`),
  };
}

let current: Settings = loadEnv();

/** The active configuration (safe to read anywhere). */
export function settings(): Settings {
  return current;
}

/**
 * Applies opts over the active settings (environment-derived on first use).
 * Only provided keys change; the last configuration wins.
 */
export function configure(opts: DataflowOptions = {}): void {
  current = applyOptions(current, opts);
}

/** configure() over a fresh environment snapshot — test seam, not API. */
export function _resetForTests(opts: DataflowOptions = {}): Settings {
  current = applyOptions(loadEnv(), opts);
  return current;
}

function applyOptions(base: Settings, opts: DataflowOptions): Settings {
  const next: Settings = { ...base };
  if (opts.apiKey !== undefined) next.apiKey = opts.apiKey;
  if (opts.endpoint !== undefined) next.endpoint = opts.endpoint;
  if (opts.httpUrl !== undefined) next.httpUrl = opts.httpUrl;
  if (opts.serviceName !== undefined) next.serviceName = opts.serviceName;
  if (opts.encryptionKey !== undefined) next.encryptionKey = opts.encryptionKey;
  if (opts.salt !== undefined) next.salt = opts.salt;
  if (opts.sampleRatio !== undefined) next.sampleRatio = opts.sampleRatio;
  if (opts.bufferSize !== undefined) next.bufferSize = opts.bufferSize;
  if (opts.disabled !== undefined) next.disabled = opts.disabled;
  if (opts.logger !== undefined) next.logger = opts.logger;
  return next;
}

/** True when the SDK is configured to ship events. */
export function enabled(): boolean {
  const s = current;
  return !s.disabled && !!s.apiKey && !!s.endpoint;
}

/**
 * Fraction in [0,1] actually applied: non-finite or negative values are
 * ignored (full fidelity), values above 1 clamp to 1.
 */
export function normalizedRatio(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 1;
  return Math.min(raw, 1);
}

/** Whether one span should ship — fleet semantics: ratio >= 1 or a random draw under it. */
export function shouldSample(): boolean {
  const ratio = normalizedRatio(current.sampleRatio);
  return ratio >= 1 || Math.random() < ratio;
}

/**
 * Resolves the HTTP API base for the REST transport and manifest reporting:
 * an explicit DATAFLOW_HTTP_URL wins (needed when the gRPC-style
 * DATAFLOW_ENDPOINT is a bare host:port); URL-form endpoints map directly;
 * a bare endpoint with no override has no derivable HTTP base and delivery
 * is skipped. Mirrors python manifest.resolve_http_base.
 */
export function resolveHttpBase(endpoint?: string, httpUrl?: string): string | null {
  const override = (httpUrl ?? settings().httpUrl ?? "").trim();
  if (override) return override.replace(/\/+$/, "");
  const ep = (endpoint ?? settings().endpoint ?? "").trim();
  if (ep.startsWith("http://") || ep.startsWith("https://")) {
    return ep.replace(/\/+$/, "");
  }
  return null;
}
