#!/usr/bin/env node
import { main } from "../scanlib.js";

// dataflow-scan: static route scanner — extract HTTP endpoints from
// JS/TS source and post them to the Dataflow service catalog.
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
