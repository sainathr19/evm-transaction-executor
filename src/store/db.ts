import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

// Each attempt is saved here before it's broadcast (ADR 0003). Amounts are stored as decimal
// text because they don't fit in SQLite's 64-bit integers.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('request', 'gap_fill')),
  idempotency_key TEXT UNIQUE,
  request_hash    TEXT,
  chain_id        INTEGER NOT NULL,
  sender          TEXT NOT NULL,
  to_address      TEXT NOT NULL,
  value           TEXT NOT NULL,
  data            TEXT NOT NULL,
  status          TEXT NOT NULL,
  nonce           INTEGER,
  gas_limit       TEXT,
  hash            TEXT,
  receipt         TEXT,
  error_code      TEXT,
  error_message   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transactions_by_status ON transactions (status, chain_id);

CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id      TEXT NOT NULL REFERENCES transactions (id),
  hash       TEXT NOT NULL,
  raw        TEXT NOT NULL,
  fees       TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_by_tx ON attempts (tx_id);
`

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  // A saved attempt must be on disk before its broadcast starts.
  db.pragma('synchronous = FULL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
