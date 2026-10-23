import { describe, expect, it } from "vitest";
import {
  createPaymentProviderConformanceSuite,
  createPaymentProviderFixtureSuite,
} from "@tpirs/contracts";
import { createRemitaPaymentProvider, remitaPaymentProviderFixture } from "./index.js";

createPaymentProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createRemitaPaymentProvider(),
}));

createPaymentProviderFixtureSuite(
  { describe, it, expect },
  () => ({ port: createRemitaPaymentProvider() }),
  remitaPaymentProviderFixture,
);
