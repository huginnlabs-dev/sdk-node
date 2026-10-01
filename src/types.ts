/**
 * Span types as they travel on the REST ingest wire (server
 * /api/v1/ingest `type` field; identical strings to the store's
 * event_type column and the gRPC enum wire names).
 */
export type EventType =
  | "FUNCTION_CALL"
  | "HTTP_SERVER"
  | "HTTP_CLIENT"
  | "GRPC"
  | "LLM_CALL"
  | "DB_QUERY";

/** Payload envelope on the REST wire (server ingestPayloadIn). */
export interface PayloadWire {
  encrypted: boolean;
  /** base64 of the payload bytes — ciphertext when encrypted, else UTF-8 JSON */
  data_b64: string;
  /** base64 of the 96-bit GCM nonce, set when encrypted */
  iv_b64: string;
  /** hex-encoded PBKDF2 salt so a dashboard can re-derive the key */
  key_salt: string;
}

/** One TraceEvent as accepted by POST /api/v1/ingest. */
export interface EventWire {
  event_id: string;
  seq: number;
  timestamp: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  type: EventType;
  service_name: string;
  name: string;
  caller_package: string;
  callee_package: string;
  function_name: string;
  duration_ms: number;
  status_code: number;
  error_message: string;
  payload: PayloadWire | null;
  metadata: Record<string, string>;
}

/** Manifest body as accepted by POST /api/v1/manifest. */
export interface ManifestWire {
  service_name: string;
  language: string;
  sdk_version: string;
  runtime_version: string;
  framework: string;
  os_arch: string;
  app_version: string;
  dependencies: { name: string; version: string }[];
}

/** One log line as accepted by POST /api/v1/logs (fields are stringified). */
export interface LogWire {
  /** Unix milliseconds. */
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  trace_id: string;
  span_id: string;
  service_name: string;
  fields: Record<string, string>;
}
