import { describe, expect, it } from "vitest";
import { createJobQueueConformanceSuite } from "@tpirs/contracts";
import { createMockJobQueue } from "./index.js";

createJobQueueConformanceSuite({ describe, it, expect }, () => ({ port: createMockJobQueue() }));

describe("createMockJobQueue drain", () => {
  it("delivers pending jobs to registered handlers", async () => {
    const queue = createMockJobQueue();
    const received: unknown[] = [];
    queue.registerHandler("work", async (payload) => {
      received.push(payload);
    });
    await queue.enqueue("work", { n: 1 });
    await queue.enqueue("work", { n: 2 });
    await queue.drain();
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    expect(queue.pending).toHaveLength(0);
  });
});
