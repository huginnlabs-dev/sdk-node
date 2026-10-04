import { defineConfig } from "vitest/config";

export default defineConfig({
  // es2022 < esnext: makes esbuild LOWER standard (stage-3) decorators in
  // the test transform — otherwise @Traced() passes through raw and Node
  // throws "Invalid or unexpected token" at suite load.
  esbuild: { target: 'es2022' },
  test: {
    include: ["test/**/*.test.ts"],
    // Restored per test file: each suite re-seeds env and resets module state.
    pool: "forks",
    testTimeout: 20000,
  },
});
