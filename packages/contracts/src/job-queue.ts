import type { JobQueue } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

export function createJobQueueConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<JobQueue>,
): void {
  const { describe, it, expect } = harness;

  describe("JobQueue conformance", () => {
    it("enqueues a job and returns an id", () =>
      withAdapter(factory, async (queue) => {
        const jobId = await queue.enqueue("conformance", { hello: "world" });
        expect(jobId.length > 0).toBe(true);
      }));

    it("returns the existing job id for a repeated dedupe key", () =>
      withAdapter(factory, async (queue) => {
        const first = await queue.enqueue("conformance", { n: 1 }, { dedupeKey: "conf-job" });
        const second = await queue.enqueue("conformance", { n: 2 }, { dedupeKey: "conf-job" });
        expect(second).toBe(first);
      }));

    it("starts and stops cleanly", () =>
      withAdapter(factory, async (queue) => {
        queue.registerHandler("conformance", async () => {
          // no-op handler for conformance
        });
        await queue.start();
        await queue.stop();
      }));
  });
}
