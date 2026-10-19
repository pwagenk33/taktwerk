import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 10, timezone: "Z", dateStrings: ["DATE"] });
  const db = drizzle(pool, { schema, mode: "default" });
  return { db, pool };
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db, folder = process.env.MIGRATIONS_DIR ?? MIGRATIONS_DIR) {
  await migrate(db, { migrationsFolder: folder });
}
