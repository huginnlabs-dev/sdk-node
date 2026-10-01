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
