import path from "node:path";
import { runSeed } from "../seed.js";
import { loadRootEnv, requireEnv } from "../env.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

loadRootEnv(repoRoot);
const connectionString = requireEnv("DATABASE_URL");

runSeed(connectionString)
  .then(() => {
    console.log("Seed complete");
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
