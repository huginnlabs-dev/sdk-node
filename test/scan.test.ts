import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main, scanDirectory, type CatalogBody, type MainStreams } from "../src/scanlib.js";
import { bodyText, closeServer, startCollector, type Collector, type RecordedRequest } from "./helpers.js";

let root = "";

const EXPRESS_APP = `const express = require("express");
const app = express();
const router = express.Router();

app.get("/users/:id", getUser);
app.post("/users", createUser);
app.all("/anything", (req, res) => res.end());
app.get("/users/:id", duplicatedRoute);
app.use("/api/v1", router);
router.delete("/items/:id", removeItem);
router.patch("/items/:id", (req, res) => { res.end(); });
app.put("/things", function updateThing(req, res) {});
// app.get("/commented", notARoute);
`;

const FASTIFY_APP = `const fastify = require("fastify")();
fastify.get("/health", healthHandler);
fastify.post("/orders", (req, reply) => reply.send({}));
`;

const KOA_APP = `import Router from "@koa/router";
const router = new Router();
router.get("/koaposts/:id", async (ctx) => { ctx.body = {}; });
router.post("/koaposts", createKoaPost);
`;

const NEST_APP = `import { Controller, Get, Post, Param, HttpCode } from "@nestjs/common";

@Controller("cats")
export class CatsController {
  @Get()
  findAll() { return []; }

  @Post(':id/adopt')
  async adopt(@Param('id') id: string) {}

  @Get('breeds')
  @HttpCode(200)
  listBreeds() {}
}

@Controller()
export class RootController {
  @Get('ping')
  ping() {}
}
`;

const HIDDEN_ROUTES = `app.get("/should-not-appear", hidden);
`;

const ROUTE_COUNT = 14; // 6 express (after dedupe) + 2 fastify + 4 nest + 2 koa
const FILE_COUNT = 4; // express.js, fastify.js, nest.controller.ts, api/koa.ts

function makeStreams(): { streams: MainStreams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: {
      out: { write: (s: string) => out.push(s) },
      err: { write: (s: string) => err.push(s) },
    },
    out,
    err,
  };
}

/** Runs fn with a deterministic DATAFLOW_* environment (restored after). */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of ["DATAFLOW_ENDPOINT", "DATAFLOW_HTTP_URL", "DATAFLOW_API_KEY", "DATAFLOW_SERVICE_NAME"]) {
    prev[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dataflow-scan-"));
  writeFileSync(join(root, "express.js"), EXPRESS_APP);
  writeFileSync(join(root, "fastify.js"), FASTIFY_APP);
  writeFileSync(join(root, "nest.controller.ts"), NEST_APP);
  mkdirSync(join(root, "api"));
  writeFileSync(join(root, "api", "koa.ts"), KOA_APP);
  // Skipped locations: dependency/build output, dot dirs, test files.
  mkdirSync(join(root, "node_modules", "fake"), { recursive: true });
  writeFileSync(join(root, "node_modules", "fake", "route.js"), HIDDEN_ROUTES);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "app.js"), HIDDEN_ROUTES);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "hooks.js"), HIDDEN_ROUTES);
  writeFileSync(join(root, "app.test.ts"), HIDDEN_ROUTES);
  writeFileSync(join(root, "user.spec.ts"), HIDDEN_ROUTES);
  writeFileSync(join(root, "readme.md"), "app.get('/nope', fn)");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scanDirectory", () => {
  it("extracts express/fastify/koa routes with one-level use() prefixes", () => {
    const result = scanDirectory(root);
    const byPath = new Map(result.routes.map((r) => [`${r.method} ${r.path}`, r]));

    expect(byPath.get("GET /users/:id")).toMatchObject({ handler: "getUser", source_file: "express.js" });
    expect(byPath.get("POST /users")).toMatchObject({ handler: "createUser" });
    expect(byPath.get("ANY /anything")).toMatchObject({ handler: "" });
    expect(byPath.get("DELETE /api/v1/items/:id")).toMatchObject({ handler: "removeItem", source_file: "express.js" });
    expect(byPath.get("PATCH /api/v1/items/:id")).toMatchObject({ handler: "" });
    expect(byPath.get("PUT /things")).toMatchObject({ handler: "updateThing" });
    expect(byPath.get("GET /health")).toMatchObject({ handler: "healthHandler", source_file: "fastify.js" });
    expect(byPath.get("POST /orders")).toMatchObject({ handler: "", source_file: "fastify.js" });
    expect(byPath.get("GET /koaposts/:id")).toMatchObject({ handler: "", source_file: "api/koa.ts" });
    expect(byPath.get("POST /koaposts")).toMatchObject({ handler: "createKoaPost" });

    expect(result.routes).toHaveLength(ROUTE_COUNT);
    expect(result.files_scanned).toBe(FILE_COUNT); // test/spec/node_modules/dist/.git skipped

    // Skipped locations must not contribute routes.
    const paths = result.routes.map((r) => r.path);
    expect(paths).not.toContain("/should-not-appear");
    expect(paths).not.toContain("/commented");

    // Dedupe on (method, path): first declaration wins.
    expect(result.routes.filter((r) => r.path === "/users/:id")).toHaveLength(1);

    // Sorted by (source_file, path, method, handler).
    const sorted = [...result.routes].sort(
      (a, b) =>
        a.source_file.localeCompare(b.source_file) ||
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method) ||
        a.handler.localeCompare(b.handler),
    );
    expect(result.routes).toEqual(sorted);
  });

  it("extracts NestJS decorators with the @Controller class prefix", () => {
    const result = scanDirectory(root);
    const byPath = new Map(result.routes.map((r) => [`${r.method} ${r.path}`, r]));

    expect(byPath.get("GET /cats")).toMatchObject({ handler: "findAll", source_file: "nest.controller.ts" });
    expect(byPath.get("POST /cats/:id/adopt")).toMatchObject({ handler: "adopt" });
    expect(byPath.get("GET /cats/breeds")).toMatchObject({ handler: "listBreeds" }); // skips @HttpCode
    expect(byPath.get("GET /ping")).toMatchObject({ handler: "ping" }); // bare @Controller()
  });

  it("caps routes at 1000 via the CLI", async () => {
    let big = "";
    for (let i = 0; i < 1200; i += 1) big += `app.get("/bulk/${i}", h);\n`;
    writeFileSync(join(root, "bulk.js"), big);
    const { streams, out } = makeStreams();
    const code = await main(["--dir", root, "--print"], streams);
    expect(code).toBe(0);
    const body = JSON.parse(out.join("")) as CatalogBody;
    expect(body.routes).toHaveLength(1000);
  });
});

describe("dataflow-scan CLI", () => {
  it("prints the catalog JSON with --print (exit 0)", async () => {
    const { streams, out, err } = makeStreams();
    const code = await main(["--dir", root, "--print", "--service", "svc"], streams);
    expect(code).toBe(0);
    const body = JSON.parse(out.join("")) as CatalogBody;
    expect(body.service_name).toBe("svc");
    expect(body.routes.some((r) => r.path === "/users/:id")).toBe(true);
    expect(err.join("")).toMatch(new RegExp(`${ROUTE_COUNT} routes across ${FILE_COUNT} files`));
  });

  it("defaults the service name to DATAFLOW_SERVICE_NAME, then the dir basename", async () => {
    await withEnv({ DATAFLOW_SERVICE_NAME: "env-svc" }, async () => {
      const { streams, out } = makeStreams();
      await main(["--dir", root, "--print"], streams);
      expect((JSON.parse(out.join("")) as CatalogBody).service_name).toBe("env-svc");
    });
    await withEnv({}, async () => {
      const { streams, out } = makeStreams();
      await main(["--dir", root, "--print"], streams);
      expect((JSON.parse(out.join("")) as CatalogBody).service_name).toBe(basename(root));
    });
  });

  it("POSTs the catalog to {base}/api/v1/catalog with X-Api-Key (exit 0)", async () => {
    const collector = await startCollector();
    try {
      const { streams, err } = makeStreams();
      const code = await main(
        ["--dir", root, "--service", "svc", "--url", collector.url, "--api-key", "df_scan_key"],
        streams,
      );
      expect(code).toBe(0);

      const reqs = await collector.waitFor("/api/v1/catalog");
      const req: RecordedRequest = reqs[0]!;
      expect(req.method).toBe("POST");
      expect(req.headers["x-api-key"]).toBe("df_scan_key");
      const body = JSON.parse(bodyText(req)) as CatalogBody;
      expect(body.service_name).toBe("svc");
      expect(body.routes.some((r) => r.path === "/api/v1/items/:id")).toBe(true);
      expect(err.join("")).toMatch(new RegExp(`posted ${ROUTE_COUNT} route\\(s\\)`));
    } finally {
      await collector.close();
    }
  });

  it("skips with exit 1 when DATAFLOW_ENDPOINT is a bare host:port", async () => {
    await withEnv({ DATAFLOW_ENDPOINT: "api.huginnlabs.com:9090" }, async () => {
      const { streams, err } = makeStreams();
      const code = await main(["--dir", root], streams);
      expect(code).toBe(1);
      expect(err.join("")).toMatch(/bare host:port has no\s+HTTP base/);
    });
  });

  it("prefers --url over DATAFLOW_HTTP_URL over DATAFLOW_ENDPOINT", async () => {
    const collector = await startCollector();
    const other = await startCollector();
    try {
      await withEnv(
        { DATAFLOW_ENDPOINT: "http://wrong.invalid:1", DATAFLOW_HTTP_URL: collector.url },
        async () => {
          // DATAFLOW_HTTP_URL overrides the URL-form endpoint...
          const { streams } = makeStreams();
          const code = await main(["--dir", root, "--api-key", "k", "--service", "svc"], streams);
          expect(code).toBe(0);
          const reqs = await collector.waitFor("/api/v1/catalog");
          expect((JSON.parse(bodyText(reqs[0]!)) as CatalogBody).service_name).toBe("svc");

          // ...and an explicit --url outranks the env.
          const { streams: s2 } = makeStreams();
          const code2 = await main(["--dir", root, "--api-key", "k", "--service", "svc", "--url", other.url], s2);
          expect(code2).toBe(0);
          await other.waitFor("/api/v1/catalog");
          expect(collector.requests.filter((r) => r.path === "/api/v1/catalog")).toHaveLength(1);
        },
      );
    } finally {
      await collector.close();
      await other.close();
    }
  });

  it("exits 1 for a bad --dir or unknown flag", async () => {
    const { streams, err } = makeStreams();
    expect(await main(["--dir", join(root, "missing")], streams)).toBe(1);
    expect(err.join("")).toMatch(/not a directory/);

    const { streams: s2, err: e2 } = makeStreams();
    expect(await main(["--wat"], s2)).toBe(1);
    expect(e2.join("")).toMatch(/unknown argument/);
  });

  it("exits 2 when the API key is missing or the POST fails", async () => {
    const collector = await startCollector();
    try {
      const { streams, err } = makeStreams();
      const code = await main(["--dir", root, "--url", collector.url], streams);
      expect(code).toBe(2);
      expect(err.join("")).toMatch(/no API key/);

      collector.respondWith(500);
      const { streams: s2, err: e2 } = makeStreams();
      const code2 = await main(["--dir", root, "--url", collector.url, "--api-key", "k"], s2);
      expect(code2).toBe(2);
      expect(e2.join("")).toMatch(/POST .* failed: HTTP 500/);
    } finally {
      await collector.close();
    }
  });

  it("exits 0 with nothing to post when no routes are found", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dataflow-scan-empty-"));
    try {
      writeFileSync(join(empty, "plain.js"), "console.log('no routes here');\n");
      const { streams, err } = makeStreams();
      expect(await main(["--dir", empty], streams)).toBe(0);
      expect(err.join("")).toMatch(/no routes found; nothing to post/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
