'use strict';
const fs   = require('fs');
const path = require('path');

// Allows the test harness to swap in a pg-mem-backed in-memory Postgres
// (via PG_TEST_ADAPTER) without touching production code paths — real
// deploys always use the real `pg` package against a real Postgres.
const pgModule = process.env.PG_TEST_ADAPTER
  ? require(process.env.PG_TEST_ADAPTER)
  : require('pg');

const { Pool } = pgModule;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
});

async function query(text, params) {
  return pool.query(text, params);
}

// Runs a SQL script one statement at a time rather than as one
// multi-statement pool.query(sql) call. This used to run schema.sql as a
// single batch, wrapped in a try/catch that swallowed the expected 42710
// (duplicate_object) error from the staff_assignments ADD CONSTRAINT
// statements on every restart after the first. The problem: a
// multi-statement query STOPS at the first failing statement, so anything
// placed after those ALTER TABLEs in the file silently never ran again
// after the first successful boot — which is exactly how the
// maintenance_requests/documents/payments tables ended up missing in
// production despite CREATE TABLE IF NOT EXISTS being idempotent on paper.
// Running statements one at a time means a single expected "already
// exists" error can never block any other statement, no matter where it's
// positioned in the script. Exported separately from initDB() so it can
// be exercised directly in tests against a synthetic script, without
// depending on the real schema.sql file's current statement order.
async function applySchema(sql) {
  // Strip "-- comment" text before splitting on ';' — a couple of the
  // comments in schema.sql contain literal semicolons in plain English
  // (e.g. "for a tenant; if requires_signature is set"), which would
  // otherwise create a false statement boundary mid-CREATE-TABLE.
  const withoutComments = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');

  const statements = withoutComments
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (err) {
      // 42710 = duplicate_object — e.g. the staff_assignments FK
      // constraints, which have no "ADD CONSTRAINT IF NOT EXISTS" form in
      // Postgres and so always "fail" this way after the first boot. Not
      // a real failure; every other statement still runs regardless.
      if (err.code === '42710') {
        console.warn('[DB] Already applied (duplicate_object), skipping:', stmt.slice(0, 70).replace(/\s+/g, ' '));
      } else {
        console.error('[DB] Schema statement failed:', stmt.slice(0, 200).replace(/\s+/g, ' '));
        throw err;
      }
    }
  }
}

async function initDB() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  await applySchema(schema);
}

module.exports = { pool, query, initDB, applySchema };
