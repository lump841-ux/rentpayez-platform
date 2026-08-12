'use strict';
// Provides a `pg`-shaped module backed by an in-memory Postgres (pg-mem),
// for testing this backend without a real Postgres instance. Loaded ONLY
// when PG_TEST_ADAPTER=./test/pgmem-adapter.js is set — production code
// (services/db.js) always uses the real `pg` package by default.
const { newDb, DataType } = require('pg-mem');

const db = newDb({ autoCreateForeignKeyIndices: true });

// gen_random_uuid() comes from the pgcrypto extension in real Postgres;
// pg-mem doesn't ship it, so register a matching extension + function so
// `CREATE EXTENSION IF NOT EXISTS pgcrypto` (in schema.sql) succeeds.
db.registerExtension('pgcrypto', (schema) => {
  schema.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true, // must generate a fresh UUID per row, not be memoized/simplified
    implementation: () => require('crypto').randomUUID(),
  });
});

const adapter = db.adapters.createPg();

// schema.sql's `sessions` table stores `sess JSONB` which is fine, and
// `expire TIMESTAMPTZ` — pg-mem supports both, no shim needed there.

class Pool extends adapter.Pool {
  constructor() { super(); }
}

module.exports = { Pool, _pgMemDb: db };
