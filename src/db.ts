import { Pool } from "pg";

import { readDatabaseUrlConfig } from "./placement.js";

export function createPool(databaseUrl = readDatabaseUrlConfig().databaseUrl): Pool {
  return new Pool({ connectionString: databaseUrl });
}
