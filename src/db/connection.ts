import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getEnv } from '../config/env.ts';
import { migrate } from './migrations.ts';

export type Db = Database.Database;

let instance: Db | undefined;

/** Opens (and migrates) the SQLite database in DATA_DIR. Pass ":memory:" for tests. */
export function openDb(path?: string): Db {
  const file = path ?? join(ensureDataDir(), 'emailer.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function getDb(): Db {
  instance ??= openDb();
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
}

export function ensureDataDir(): string {
  const dir = getEnv().DATA_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}
