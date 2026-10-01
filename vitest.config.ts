import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Restored per test file: each suite re-seeds env and resets module state.
    pool: "forks",
    testTimeout: 20000,
  },
});
