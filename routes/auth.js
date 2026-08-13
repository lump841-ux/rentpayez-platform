'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const db      = require('../services/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'org';
}

// ── Sign up a brand-new organization (creates the org + its org_admin) ──
router.post('/signup-organization', async (req, res) => {
  try {
    const { orgName, adminName, email, password } = req.body || {};
    if (!orgName || !adminName || !email || !password) {
      return res.status(400).json({ error: 'orgName, adminName, email, and password are all required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    let slug = slugify(orgName);
    const { rows: existing } = await db.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (existing.length) slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;

    const orgResult = await db.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug`,
      [orgName, slug]
    );
    const org = orgResult.rows[0];

    const hash = await bcrypt.hash(password, 12);
    const userResult = await db.query(
      `INSERT INTO organization_users (organization_id, email, password_hash, name, role, status)
       VALUES ($1, $2, $3, $4, 'org_admin', 'active')
       RETURNING id, email, name, role, organization_id`,
      [org.id, email.toLowerCase().trim(), hash, adminName]
    );
    const user = userResult.rows[0];

    await db.query(
      `INSERT INTO audit_logs (organization_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
       VALUES ($1, $2, 'organization_user', 'organization.create', 'organization', $1, $3)`,
      [org.id, user.id, JSON.stringify({ orgName })]
    );

    delete req.session.tenant; // see routes/tenant-auth.js login for why this matters
    req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role, organizationId: org.id };
    res.json({ organization: org, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    console.error('signup-organization error:', err);
    res.status(500).json({ error: 'Something went wrong creating your organization.' });
  }
});

// ── Staff / org_admin login ──────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await db.query(
      `SELECT id, organization_id, email, password_hash, name, role, status
       FROM organization_users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user || user.status === 'disabled') return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // First successful login with the invite temp password counts as
    // accepting the invite — flip the account to active.
    if (user.status === 'invited') {
      await db.query(`UPDATE organization_users SET status = 'active' WHERE id = $1`, [user.id]);
      user.status = 'active';
    }

    delete req.session.tenant; // see routes/tenant-auth.js login for why this matters
    req.session.user = {
      id: user.id, email: user.email, name: user.name, role: user.role,
      organizationId: user.organization_id,
    };
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, organizationId: user.organization_id } });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Something went wrong logging you in.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

module.exports = router;
