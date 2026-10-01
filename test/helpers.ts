import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

import { _resetForTests as resetConfig } from "../src/config.js";
import { _resetForTests as resetPipeline } from "../src/pipeline.js";
import { _resetEnvelopeForTests } from "../src/envelope.js";
import { _resetManifestForTests } from "../src/manifest.js";
import { _resetAgentForTests } from "../src/agent.js";

/**
 * Test scaffolding: a local collector HTTP server that records every
 * request (ingest batches and manifests), and SDK state resets.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface Collector {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Resolves when at least n requests with the given path have arrived. */
  waitFor(path: string, n?: number, timeoutMs?: number): Promise<RecordedRequest[]>;
  respondWith(status: number): void;
  close(): Promise<void>;
}

export function startCollector(): Promise<Collector> {
  const requests: RecordedRequest[] = [];
  let status = 200;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ last_seq: 0, accepted: 1 }));
    });
  });

  return new Promise((resolvePromise) => {
    // Windows-host lesson from the fleet: bind and dial 127.0.0.1 explicitly.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const collector: Collector = {
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        respondWith(s: number) {
          status = s;
        },
        waitFor(path, n = 1, timeoutMs = 8000) {
          const deadline = Date.now() + timeoutMs;
          return new Promise((res, rej) => {
            const tick = (): void => {
              const found = requests.filter((r) => r.path === path);
              if (found.length >= n) {
                res(found);
                return;
              }
              if (Date.now() > deadline) {
                rej(new Error(`timeout waiting for ${n} x ${path} (got ${found.length})`));
                return;
              }
              setTimeout(tick, 25);
            };
            tick();
          });
        },
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      };
      resolvePromise(collector);
    });
  });
}

export function parseBody(req: RecordedRequest): { events: unknown[] } {
  return JSON.parse(bodyText(req)) as { events: unknown[] };
}

/** Decodes a request body, transparently gunzipping Content-Encoding: gzip. */
export function bodyText(req: RecordedRequest): string {
  if (req.headers["content-encoding"] === "gzip") {
    return gunzipSync(req.body).toString("utf8");
  }
  return req.body.toString("utf8");
}

/** Listens on an ephemeral 127.0.0.1 port and resolves once actually listening. */
export function listenOnce(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Closes a server deterministically, dropping pooled keep-alive sockets. */
export function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Resets every SDK module to a fresh, environment-derived state. */
export function resetSdk(): void {
  resetConfig();
  resetPipeline();
  _resetEnvelopeForTests();
  _resetManifestForTests();
  _resetAgentForTests();
}
