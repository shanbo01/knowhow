import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Ensure wrangler.local.jsonc (or your deployment wrangler config) binds D1 as `DB` before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
