import type { ExpectStatic } from "vitest";

export interface ConformanceHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: ExpectStatic;
}

export interface AdapterHandle<TPort> {
  port: TPort;
  cleanup?: () => Promise<void>;
}

export type AdapterFactory<TPort> = () => Promise<AdapterHandle<TPort>> | AdapterHandle<TPort>;

export async function withAdapter<TPort>(
  factory: AdapterFactory<TPort>,
  fn: (port: TPort) => Promise<void> | void,
): Promise<void> {
  const handle = await factory();
  try {
    await fn(handle.port);
  } finally {
    await handle.cleanup?.();
  }
}

/**
 * The minimum configuration every conforming adapter factory must provide.
 * Suites document their requirements against these shared fixtures.
 */
export const conformanceFixtures = {
  currency: "NGN",
  assetTypeKey: "bike",
  requiredAttributeKey: "plate_number",
  smsRecipient: "+2348000000001",
  identityUsername: "conformance.user",
  identityPassword: "correct-horse-battery-staple",
  secretRef: "conformance/secret",
  secretValue: "conformance-value",
  receiptTemplateKey: "payment_receipt",
} as const;
