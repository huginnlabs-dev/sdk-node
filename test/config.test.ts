import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetForTests, configure, enabled, loadEnv, resolveHttpBase, settings } from "../src/config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("config/env", () => {
  beforeEach(() => {
    delete process.env.DATAFLOW_API_KEY;
    delete process.env.DATAFLOW_ENDPOINT;
    delete process.env.DATAFLOW_HTTP_URL;
    delete process.env.DATAFLOW_SERVICE_NAME;
    delete process.env.DATAFLOW_ENCRYPTION_KEY;
    delete process.env.DATAFLOW_SALT;
    delete process.env.DATAFLOW_SAMPLE_RATIO;
    delete process.env.DATAFLOW_DISABLED;
    delete process.env.DATAFLOW_BUFFER_SIZE;
  });

  it("falls back to fleet defaults", () => {
    const s = loadEnv();
    expect(s.apiKey).toBe("");
    expect(s.endpoint).toBe("api.huginnlabs.com:9090");
    expect(s.serviceName.length).toBeGreaterThan(0); // hostname
    expect(s.sampleRatio).toBe(1);
    expect(s.bufferSize).toBe(10000);
    expect(s.disabled).toBe(false);
    expect(s.encryptionKey).toBe("");
    expect(s.salt).toBe("");
  });

  it("parses the DATAFLOW_* environment contract", () => {
    withEnv(
      {
        DATAFLOW_API_KEY: "df_key",
        DATAFLOW_ENDPOINT: "https://ingest.example.com",
        DATAFLOW_HTTP_URL: "http://ingest.example.com:8080/",
        DATAFLOW_SERVICE_NAME: "orders",
        DATAFLOW_ENCRYPTION_KEY: "s3cret",
        DATAFLOW_SALT: "aabbccdd",
        DATAFLOW_SAMPLE_RATIO: "0.25",
        DATAFLOW_BUFFER_SIZE: "42",
        DATAFLOW_DISABLED: "yes",
      },
      () => {
        const s = loadEnv();
        expect(s.apiKey).toBe("df_key");
        expect(s.endpoint).toBe("https://ingest.example.com");
        expect(s.httpUrl).toBe("http://ingest.example.com:8080/");
        expect(s.serviceName).toBe("orders");
        expect(s.encryptionKey).toBe("s3cret");
        expect(s.salt).toBe("aabbccdd");
        expect(s.sampleRatio).toBe(0.25);
        expect(s.bufferSize).toBe(42);
        expect(s.disabled).toBe(true);
      },
    );
  });

  it("treats malformed numerics as defaults (fleet behavior)", () => {
    withEnv({ DATAFLOW_SAMPLE_RATIO: "abc", DATAFLOW_BUFFER_SIZE: "x" }, () => {
      const s = loadEnv();
      expect(s.sampleRatio).toBe(1);
      expect(s.bufferSize).toBe(10000);
    });
  });

  it("recognizes the truthy spellings for DATAFLOW_DISABLED", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
      withEnv({ DATAFLOW_DISABLED: v }, () => {
        expect(loadEnv().disabled).toBe(true);
      });
    }
    for (const v of ["0", "false", "", "no", "off", "maybe"]) {
      withEnv({ DATAFLOW_DISABLED: v }, () => {
        expect(loadEnv().disabled).toBe(false);
      });
    }
  });

  it("enabled() requires key+endpoint and absence of the kill switch", () => {
    _resetForTests();
    expect(enabled()).toBe(false); // no key

    configure({ apiKey: "k" });
    expect(enabled()).toBe(true); // endpoint has a default

    configure({ apiKey: "k", disabled: true });
    expect(enabled()).toBe(false);

    configure({ apiKey: "k", disabled: false });
    expect(enabled()).toBe(true);
  });

  it("configure() merges over the current settings", () => {
    _resetForTests({ apiKey: "k1" });
    expect(settings().apiKey).toBe("k1");
    configure({ serviceName: "svc", sampleRatio: 0.5 });
    expect(settings().apiKey).toBe("k1");
    expect(settings().serviceName).toBe("svc");
    expect(settings().sampleRatio).toBe(0.5);
  });
});

describe("resolveHttpBase", () => {
  it("prefers the DATAFLOW_HTTP_URL override over everything", () => {
    _resetForTests({ endpoint: "https://from-endpoint.example.com", httpUrl: "http://override:9999" });
    expect(resolveHttpBase()).toBe("http://override:9999");
    // The override wins even when an endpoint argument is passed:
    expect(resolveHttpBase("https://arg.example.com")).toBe("http://override:9999");
  });

  it("falls back to a URL-form endpoint argument on a clean config", () => {
    _resetForTests();
    expect(resolveHttpBase("https://arg.example.com")).toBe("https://arg.example.com");
    expect(resolveHttpBase("host:9090", "http://override:9999")).toBe("http://override:9999");
  });

  it("maps URL-form endpoints directly and strips trailing slashes", () => {
    _resetForTests();
    expect(resolveHttpBase("https://api.example.com/")).toBe("https://api.example.com");
    expect(resolveHttpBase("http://api.example.com/base/")).toBe("http://api.example.com/base");
  });

  it("returns null for a bare host:port with no override", () => {
    _resetForTests();
    expect(resolveHttpBase("api.huginnlabs.com:9090")).toBeNull();
    expect(resolveHttpBase("")).toBeNull();
  });

  it("resolves DATAFLOW_HTTP_URL from the environment", () => {
    process.env["DATAFLOW_HTTP_URL"] = "http://env-override:7000";
    _resetForTests({ endpoint: "grpc-host:9090" });
    expect(resolveHttpBase()).toBe("http://env-override:7000");
    delete process.env["DATAFLOW_HTTP_URL"];
  });
});
