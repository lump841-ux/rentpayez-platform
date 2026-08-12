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
  await pool.query(schema);
}

module.exports = { pool, query, initDB };
