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

async function initDB() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
  } catch (err) {
    // 42710 = duplicate_object (Postgres). schema.sql is re-run in full on
    // every server boot, and every statement in it is idempotent (CREATE
    // TABLE/INDEX ... IF NOT EXISTS) except the two ADD CONSTRAINT
    // statements wiring up staff_assignments' foreign keys — Postgres has
    // no "ADD CONSTRAINT IF NOT EXISTS". On the very first boot those
    // constraints don't exist yet and get created fine; on every restart
    // after that they already exist and this specific error is expected,
    // not a real failure, so it must not crash the process.
    if (err.code === '42710') {
      console.warn('[DB] Schema already applied (constraints exist) — continuing.');
    } else {
      throw err;
    }
  }
}

module.exports = { pool, query, initDB };
