import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests } from "../src/config.js";
import {
  _resetManifestForTests,
  buildManifest,
  detectFramework,
  readNearestPackageJson,
  sendManifest,
  MAX_DEPS,
} from "../src/manifest.js";
import { SDK_VERSION } from "../src/version.js";
import { resetSdk, startCollector, type Collector } from "./helpers.js";

let collector: Collector;

beforeEach(() => {
  _resetForTests();
  _resetManifestForTests();
});

afterEach(async () => {
  await collector?.close();
});

describe("manifest", () => {
  it("carries the fleet wire shape with language 'node'", () => {
    const m = buildManifest("orders", { dependencies: { express: "^4.21.0" } });
    expect(m).toEqual({
      service_name: "orders",
      language: "node",
      sdk_version: SDK_VERSION,
      runtime_version: process.version,
      framework: "express",
      os_arch: `${process.platform}/${process.arch}`,
      app_version: "",
      dependencies: [{ name: "express", version: "^4.21.0" }],
    });
  });

  it("detects frameworks in the fleet's priority order", () => {
    expect(detectFramework({ express: "1", fastify: "1" })).toBe("express");
    expect(detectFramework({ fastify: "1", koa: "1" })).toBe("fastify");
    expect(detectFramework({ koa: "1", next: "1" })).toBe("koa");
    expect(detectFramework({ next: "1", "@nestjs/core": "1" })).toBe("next");
    expect(detectFramework({ "@nestjs/core": "1" })).toBe("nestjs");
    expect(detectFramework({ lodash: "1" })).toBe("");
    expect(detectFramework(undefined)).toBe("");
  });

  it("includes production dependencies only, sorted and capped", () => {
    const deps: Record<string, string> = { zod: "1", alpha: "2", mid: "3" };
    for (let i = 0; i < 600; i += 1) deps[`pkg-${String(i).padStart(3, "0")}`] = "0.0.1";
    const m = buildManifest("svc", { dependencies: deps });
    expect(m.dependencies).toHaveLength(MAX_DEPS);
    const names = m.dependencies.map((d) => d.name);
    expect(names[0]).toBe("alpha"); // real deps sorted in
    expect([...names].sort()).toEqual(names); // fully sorted
    expect(names).not.toContain("pkg-500"); // capped
  });

  it("reads the nearest package.json walking up from cwd", () => {
    const pkg = readNearestPackageJson(import.meta.dirname ?? ".");
    expect(pkg).not.toBeNull();
    // The SDK's own package.json keeps everything in devDependencies —
    // production deps are empty.
    expect(pkg!.dependencies).toEqual({});
  });

  it("POSTs /api/v1/manifest once per process with X-Api-Key", async () => {
    collector = await startCollector();
    _resetForTests({ apiKey: "df_manifest_key", endpoint: collector.url });

    sendManifest();
    sendManifest(); // once-per-process guard

    const reqs = await collector.waitFor("/api/v1/manifest", 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(reqs).toHaveLength(1);
    const req = reqs[0]!;
    expect(req.headers["x-api-key"]).toBe("df_manifest_key");
    expect(req.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(req.body.toString("utf8")) as Record<string, unknown>;
    expect(body["language"]).toBe("node");
    expect(body["sdk_version"]).toBe(SDK_VERSION);
    expect(typeof body["runtime_version"]).toBe("string");
    expect(typeof body["os_arch"]).toBe("string");
    expect(Array.isArray(body["dependencies"])).toBe(true);
  });

  it("skips the manifest when no HTTP base is resolvable", async () => {
    collector = await startCollector(); // not the endpoint
    _resetForTests({ apiKey: "k", endpoint: "grpc-only:9090" });
    sendManifest();
    await new Promise((r) => setTimeout(r, 150));
    expect(collector.requests).toHaveLength(0);
  });

  it("resets cleanly between tests", async () => {
    collector = await startCollector();
    resetSdk();
    _resetManifestForTests();
    _resetForTests({ apiKey: "k", endpoint: collector.url });
    sendManifest();
    await collector.waitFor("/api/v1/manifest", 1);
  });
});
