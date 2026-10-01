# @huginnlabs/dataflow

HuginnLabs Dataflow SDK for Node.js/TypeScript — runtime tracing with
end-to-end-encrypted payloads. Zero runtime dependencies; ships over the
REST ingest API (`POST /api/v1/ingest`).

```bash
npm install @huginnlabs/dataflow
```

## Quick start

```js
import dataflow from "@huginnlabs/dataflow";

dataflow.configure({
  apiKey: process.env.DATAFLOW_API_KEY,
  endpoint: "https://ingest.example.com", // or DATAFLOW_ENDPOINT
});
```

Everything also configures from `DATAFLOW_*` environment variables — with a
complete environment, no code changes are needed.

### Express

```js
import express from "express";
import dataflow from "@huginnlabs/dataflow";

const app = express();
app.use(dataflow.middleware());       // opens an HTTP_SERVER span per request
app.get("/users/:id", handler);
app.use(dataflow.errorMiddleware());  // register LAST: records next(err)
app.listen(3000);
```

Every request becomes an `HTTP_SERVER` span named after the route template
(`GET /users/:id`, mount prefixes included: `GET /api/v1/users/:id`).
Handler errors that reach `next(err)` are recorded with their message and a
stack clipped to 8192 characters under `error.stack`. Code inside handlers
participates automatically:

```js
app.get("/ship", async (req, res) => {
  await dataflow.trace("payments.Charge", (span) => {
    span.setData("order", order);      // encrypted when a key is configured
    span.setAttr("region", "eu-1");
  });
  res.json({ ok: true });
});
```

### Fastify

```js
import Fastify from "fastify";
import dataflow from "@huginnlabs/dataflow";

const app = Fastify();
await app.register(dataflow.fastifyPlugin);
app.get("/users/:id", handler);       // span name: "GET /users/:id"
```

### Plain node:http

```js
import http from "node:http";
import dataflow from "@huginnlabs/dataflow";

http.createServer(dataflow.instrumentServer(handler)).listen(3000);
```

### Manual spans

```js
// trace() roots a trace (or nests under the active one), span() nests:
await dataflow.trace("warehouse.Reserve", async (span) => {
  span.setData("sku", "B-01");
  await dataflow.span("inventory.Check", async (child) => {
    // joins the same trace; child of warehouse.Reserve
  });
});

// accessor for the active span (AsyncLocalStorage-backed):
dataflow.currentSpan()?.setAttr("note", "inside a request");
```

## Outgoing HTTP & database tracing

`instrumentHttp()` monkey-patches `node:http` / `node:https`
(`request`/`get` on the module objects) and global `fetch` so every
outgoing call emits an `HTTP_CLIENT` span:

```js
dataflow.instrumentHttp();            // once, at startup
...
dataflow.restoreHttp();               // undo everything (originals restored)
```

Wire behavior (identical to the Go transport wrapper):

- Spans are named `METHOD host/path` — `GET api.example.com/orders` — with
  the host kept verbatim (port included when the caller wrote one), and
  `http.method` + `http.url` metadata. The span joins the active trace
  (child of the request span when called inside middleware).
- Calls joining an active trace inject `X-Dataflow-Trace-Id` so a
  downstream Dataflow service continues the same trace — unless the caller
  already set that header. No active trace: the span still ships (as a
  fresh root) but no header is added.
- The response status becomes `status_code`; 5xx additionally record a
  generic `http 5xx` error. Transport failures record the error with
  status 503. The call itself is never altered or blocked.
- The SDK's own delivery POSTs never trace themselves.

Caveats: patching mutates the shared module objects, so it works even when
`http`/`https` were imported before instrumentation — but code that
destructured `const { request } = require("http")` (or
`import { request } from "node:http"`) before `instrumentHttp()` keeps a
reference to the original function and bypasses the patch. Call
`instrumentHttp()` before destructure-heavy code, or use global `fetch`,
which is always covered.

`dbSpan(system, statement, fn)` wraps a block in a `DB_QUERY` span — there
are no dedicated driver wrappers, wrap your client calls manually (e.g.
around `pg.Pool.query`):

```js
await dataflow.dbSpan("postgres", "SELECT * FROM orders WHERE id = $1", async () => {
  return pool.query("SELECT * FROM orders WHERE id = $1", [id]);
});
```

The span is named after the statement summary — verb plus first table
reference (`SELECT orders`, `INSERT users`), the exact `stmtSummary` of the
Go/Python SDKs — with the db system as `callee_package`. Metadata carries
`db.system` and the statement single-spaced and truncated to 200
characters under `db.statement`; parameter values are never read or sent.
Success sets status 200; a throw records the error, `error.stack` (clipped
to 8192 chars) and status 500, then re-throws the original error.

## Crash capture

`capture(fn)` runs a sync or async block, records any error on the active
span (or a short-lived synthetic `exception` span when nothing is being
traced), and always re-throws the original error:

```js
dataflow.capture(() => process(order));   // sync
await dataflow.capture(async () => ...);  // async
```

Wire shape (WS4, same as the fleet's panic capture): status 500,
`error_message` = `String(err)` truncated to 500 characters, and the
`error.stack` metadata clipped to 8192 characters from the top (the
throwing frames).

`captureUncaught()` installs `uncaughtException` / `unhandledRejection`
handlers that record escaping crashes on synthetic `uncaught exception`
spans (same wire shape). Idempotent; a no-op while the SDK is disabled
(nothing is installed, nothing is recorded). `restoreCrash()` removes the
handlers again.

> **Warning:** Node suppresses the default crash-and-exit whenever *any*
> `uncaughtException` listener is present — and `unhandledRejection`
> listeners similarly alter default rejection behavior. Installing
> `captureUncaught()` therefore changes how your process exits. Pair it
> with your own exit logic, e.g.:
>
> ```js
> dataflow.captureUncaught();
> process.on("uncaughtException", () => process.exit(1));
> ```

Recording is best-effort end to end: a failure while recording never masks
the original error, and existing listeners keep running untouched.

## Log capture

Application logs ship to the same project as traces, correlated with the
active span:

```js
dataflow.info("order shipped", { order_id: order.id });       // info level
dataflow.debug("cache miss", { key: key });                   // debug
dataflow.warn("slow query", { ms: String(elapsed) });         // warn
dataflow.error("payment failed", { code: "card_declined" });  // error
dataflow.log("warning", "legacy level");                      // normalized to warn
```

Inside `dataflow.trace()` / `dataflow.span()` / HTTP middleware, each line
carries the current span's `trace_id` and `span_id`, so a dashboard can jump
from a log line to the exact request; outside a trace both ids are empty.
Field values are stringified (`String(v)`) and capped at 50 fields x 512
characters; messages are clipped to 8KB (the server's clamp points).

`captureConsole()` mirrors the console into the same log stream:

```js
dataflow.captureConsole();   // once, at startup
console.info("boot ok");     // printed as usual AND shipped as an info line
dataflow.restoreConsole();   // undo (original methods restored by identity)
```

- **Output is never swallowed or altered**: every patched call is forwarded
  to the original console method first, unguarded — output, formatting, and
  even an error the original raises behave exactly as without the SDK.
  Recording runs afterwards and is best-effort; it can never break the
  forwarded call. Level mapping: `console.debug` -> debug, `console.log` ->
  info, `console.info` -> info, `console.warn` -> warn, `console.error` ->
  error.
- Installing is idempotent; `restoreConsole()` restores the original
  methods and never clobbers a third-party patch made after the install.
- While the SDK is disabled, the console still forwards — nothing is
  recorded or sent.

Delivery is best-effort by design: lines buffer in a bounded 1024-line ring
(oldest dropped, drops counted) and POST as `{"logs":[...]}` to
`{base}/api/v1/logs` with an `X-Api-Key` header — every 500ms, at 50
buffered lines, or when you call `await dataflow.flushLogs()`. Batches are
capped at 1000 lines; a POST gets a 5s timeout and one retry, then the
batch is dropped. A bare `host:port` endpoint with no `DATAFLOW_HTTP_URL`
has no derivable HTTP base — log shipping stays off. The flusher timer is
unref'd so it never holds a short-lived process open (a final flush runs
best-effort on `beforeExit`), and the SDK's own log POSTs go through the
pristine fetch, so log shipping never creates `HTTP_CLIENT` spans of
itself.

## Route scanning (`dataflow-scan`)

A static scanner extracts declared HTTP endpoints from JS/TS source —
regex line scanning, no AST dependencies, scanned code is never imported
or executed — and posts them to the Dataflow service catalog
(`POST {base}/api/v1/catalog`):

```bash
npx dataflow-scan --dir . --url https://ingest.example.com --api-key df_...
npx dataflow-scan --print          # print the catalog JSON instead of posting
```

Supported: Express (method calls incl. `Router`, one level of
`app.use("/base", router)` prefixes — conservative), Fastify (flat),
Koa (`router.get(...)`), and NestJS (`@Get`/`@Post`/... decorators joined
with the `@Controller` class prefix). Hapi is not supported. Path params
are kept as written (`:id` or `{id}`); routes are deduped on
(method, path), sorted, and capped at 1000 (the server limit).

| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--dir` | — | `.` | Directory to scan (skips `node_modules`, `dist`, `build`, `.git`, `*.test.*`, `*.spec.*`) |
| `--service` | `DATAFLOW_SERVICE_NAME` | dir basename | `service_name` in the catalog body |
| `--url` | `DATAFLOW_HTTP_URL`, then URL-form `DATAFLOW_ENDPOINT` | — | Dataflow HTTP base |
| `--api-key` | `DATAFLOW_API_KEY` | — | Authenticates the POST |
| `--print` | — | — | Print JSON to stdout, do not post |

The POST body is `{"service_name": "...", "routes": [{"method", "path",
"handler", "source_file"}]}` with `source_file` repo-relative using
forward slashes; a summary (`N routes across M files`) goes to stderr.
Exit codes: `0` ok (posted, printed, or nothing to post), `1` skip/scan
error (bad `--dir`, unknown flag, or a bare `host:port` endpoint with no
derivable HTTP base), `2` catalog POST failed (missing API key, network
error, non-2xx response).

## Configuration

`configure(options)` merges over the environment-derived settings; the last
configuration wins.

| Option | Environment variable | Default | Meaning |
|---|---|---|---|
| `apiKey` | `DATAFLOW_API_KEY` | — | Project key; required for delivery |
| `endpoint` | `DATAFLOW_ENDPOINT` | `api.huginnlabs.com:9090` | `http(s)://host:port` URL, or a bare gRPC `host:port` |
| `httpUrl` | `DATAFLOW_HTTP_URL` | — | HTTP API base when the endpoint is a bare `host:port` |
| `serviceName` | `DATAFLOW_SERVICE_NAME` | OS hostname | Labels every event |
| `encryptionKey` | `DATAFLOW_ENCRYPTION_KEY` | — | Enables client-side payload encryption |
| `salt` | `DATAFLOW_SALT` | random 16 bytes | Hex-encoded PBKDF2 salt |
| `sampleRatio` | `DATAFLOW_SAMPLE_RATIO` | `1` | Fraction of spans shipped, in [0,1] |
| `bufferSize` | `DATAFLOW_BUFFER_SIZE` | `10000` | In-memory buffer (drop-oldest on overflow) |
| — | `DATAFLOW_APP_VERSION` | — | Deployment tag (manifest + `agent.app_version`) |
| — | `DATAFLOW_ENV` | — | Environment label (manifest + `agent.env`) |
| `disabled` | `DATAFLOW_DISABLED` | `false` | `1/true/yes/on` kills the SDK entirely |

Delivery is active when the SDK is not disabled and both an API key and an
endpoint are present.

## Wire format notes

- Events POST to `{base}/api/v1/ingest` as `{"events":[...]}` with an
  `X-Api-Key` header; batches are capped at 2000 events (the server limit).
  Bodies over 4KB are gzipped (`Content-Encoding: gzip`).
- Log lines POST to `{base}/api/v1/logs` as `{"logs":[{timestamp, level,
  message, trace_id, span_id, service_name, fields}]}` with the same
  `X-Api-Key` header; batches are capped at 1000 lines (the server limit).
- Trace and span ids are 16 hex characters, matching every other fleet SDK.
  Incoming `X-Dataflow-Trace-Id` request headers join upstream traces; the
  same header is set on responses so downstream services fan out.
- Payloads captured with `setData` travel as `payload.data_b64` (base64);
  when `DATAFLOW_ENCRYPTION_KEY` is set they are sealed client-side with
  AES-256-GCM under a key derived via PBKDF2-SHA256 (10 000 iterations,
  32-byte key, 16-byte salt, 96-bit random IV) — the exact scheme of the
  Go encoder: `payload = {encrypted: true, data_b64, iv_b64, key_salt}`
  with `key_salt` hex. Only field NAMES travel as plaintext metadata
  (`data.fields`) with PII categories (`data.pii`) classified client-side.
- The first error recorded on a span wins; the HTTP middleware's generic
  `http 500` never clobbers a specific handler error.
- A service manifest (language `node`, runtime version, framework,
  production dependency inventory) POSTs to `/api/v1/manifest` once per
  process. Failures are always silent.
- Delivery is best-effort by design: a 5s request timeout, retry with
  backoff, drop after 3 attempts — nothing ever throws into your app. A
  final flush runs on `beforeExit`/`SIGTERM`/`SIGINT` (best-effort, capped
  at 2s).

## Development

```bash
npm install
npm run build      # ESM + CJS + types into dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## License

MIT
