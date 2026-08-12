'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path    = require('path');
const db      = require('./services/db');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Session store ────────────────────────────────────────────────────
// Uses the `sessions` table created by database/schema.sql via
// connect-pg-simple, unless PG_TEST_ADAPTER is set (sandbox/unit tests),
// in which case an in-memory store is used instead — pg-mem does not
// implement enough of the wire protocol for connect-pg-simple's raw SQL.
let sessionStore;
if (!process.env.PG_TEST_ADAPTER) {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({ pool: db.pool, tableName: 'sessions', createTableIfMissing: false });
}

const isProd = process.env.NODE_ENV === 'production';
if (isProd) app.set('trust proxy', 1); // required for secure cookies behind Railway's/any reverse proxy
app.use(session({
  store: sessionStore, // undefined -> express-session's default MemoryStore (test mode only)
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/orgs'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await db.initDB();
  app.listen(PORT, () => console.log(`Rent Pay Easy platform API listening on :${PORT}`));
}

if (require.main === module) {
  start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
}

module.exports = { app, start };
