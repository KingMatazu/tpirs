import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    /**
     * The schema suite boots a Fastify app, registers swagger and ~40 routes in a
     * `beforeAll`, then injects a request per route. That is comfortably inside
     * the defaults on an idle machine and occasionally over them during a
     * full-repo run, where every other package is building and testing at the
     * same time — it failed intermittently and only ever in the full run. The
     * budget is raised rather than the suite split, because the boot is the point
     * (it proves the schemas serialize the payloads the handlers actually send).
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
