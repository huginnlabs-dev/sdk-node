import { cpus } from "node:os";

import { SDK_VERSION } from "./version.js";

/**
 * Host/process descriptor stamped onto entry-point (HTTP_SERVER) spans —
 * the Node flavour of the fleet's agent.go agent_attrs: OS, arch, runtime,
 * CPU budget, pid and uptime; DATAFLOW_ENV and DATAFLOW_APP_VERSION tag
 * deployments.
 */

let cached: [string, string][] | null = null;
const processStart = Date.now();

export function agentAttrs(): [string, string][] {
  if (cached !== null) return cached;
  const add = (k: string, v: string): void => {
    if (v) cached!.push([k, v]);
  };
  cached = [];
  add("agent.os", `${process.platform}/${process.arch}`);
  add("agent.runtime", `node ${process.version}`);
  add("agent.sdk", `node-sdk/${SDK_VERSION}`);
  add("agent.cpu", String(cpus().length || 1));
  add("agent.pid", String(process.pid));
  add("agent.started", String(processStart));
  add("agent.env", process.env["DATAFLOW_ENV"] ?? "");
  add("agent.app_version", process.env["DATAFLOW_APP_VERSION"] ?? "");
  return cached;
}

/** Test seam. */
export function _resetAgentForTests(): void {
  cached = null;
}
