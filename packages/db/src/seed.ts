import { createDb, type AnyDb } from "./connection.js";

export type SeedFn = (db: AnyDb) => Promise<void>;

/**
 * Phase 0 has no schema, so seeding is a no-op placeholder. Phase 1 adds
 * tenant/zone/role seeds and wires them here.
 */
export const seed: SeedFn = async () => {
  // intentionally empty until Phase 1
};

export async function runSeed(connectionString: string): Promise<void> {
  const db = createDb({ connectionString });
  try {
    await seed(db);
  } finally {
    await db.destroy();
  }
}
