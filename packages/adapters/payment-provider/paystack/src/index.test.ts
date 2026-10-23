import { describe, expect, it } from "vitest";
import {
  createPaymentProviderConformanceSuite,
  createPaymentProviderFixtureSuite,
} from "@tpirs/contracts";
import { createPaystackPaymentProvider, paystackPaymentProviderFixture } from "./index.js";

createPaymentProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createPaystackPaymentProvider(),
}));

createPaymentProviderFixtureSuite(
  { describe, it, expect },
  () => ({ port: createPaystackPaymentProvider() }),
  paystackPaymentProviderFixture,
);
