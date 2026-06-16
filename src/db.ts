import { Pool } from "pg";

import { requireEnv } from "./config.js";

export function createPool(databaseUrl = requireEnv("DATABASE_URL")): Pool {
  return new Pool({ connectionString: databaseUrl });
}
