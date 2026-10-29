import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // DB-backed suites run alongside every other package in CI; a hook that
    // migrates or a test that writes a month of activity can exceed the 5s
    // default on a loaded machine. The assertions are correctness, not latency.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
