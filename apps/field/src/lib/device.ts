/**
 * The device identity sent with login, so the server can bind the handset to the
 * officer (Phase 1 device binding). The value is a random id, not a fingerprint:
 * it identifies *this browser profile on this phone*, survives a reload, and
 * says nothing about the person holding it.
 */
const DEVICE_KEY = "tpirs.field.deviceId";

/** Platform label recorded with the binding; free text, not an enum on the wire. */
export function platform(): string {
  const agent = globalThis.navigator.userAgent;
  if (/android/i.test(agent)) return "android";
  if (/iphone|ipad|ipod/i.test(agent)) return "ios";
  return "web";
}

/**
 * Returns the stored device id, creating one on first use. Storage may be
 * unavailable (private mode, storage disabled); the app still works, it just
 * registers as a new device on every launch.
 */
export function deviceId(storage: Storage | undefined = safeStorage()): string {
  if (storage === undefined) return newDeviceId();
  try {
    const existing = storage.getItem(DEVICE_KEY);
    if (existing !== null && existing !== "") return existing;
    const created = newDeviceId();
    storage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return newDeviceId();
  }
}

function newDeviceId(): string {
  return globalThis.crypto.randomUUID();
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
