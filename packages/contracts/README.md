# @tpirs/contracts

Conformance test suites for every port. Each suite is a framework-agnostic factory function: adapter packages inject their test framework's `describe`/`it`/`expect` and an adapter factory, then the suite registers the shared behaviors an adapter must satisfy to implement the port.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createSmsProviderConformanceSuite, smsFixtures } from "@tpirs/contracts";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";

createSmsProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockSmsProvider(),
}));
```

Fixtures (`conformanceFixtures`) define the minimum configuration a factory must provide (e.g. the FeeEngine factory must quote a positive amount for asset type `bike` in currency `NGN`). Mock adapters ship pre-configured with these fixtures; real adapters configure them in the adapter's own tests. A new adapter is accepted only when its suite passes.
