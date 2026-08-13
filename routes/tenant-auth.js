'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../services/db');
const { requireTenantAuth } = require('../middleware/auth');

const router = express.Router();

// ── Tenant login ──────────────────────────────────────────────────────
// Tenants log in with the temp password staff hand them when their record
// is created (see routes/orgs.js). Same "first login activates the
// invited account" pattern used for staff.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await db.query(
      `SELECT id, organization_id, unit_id, email, password_hash, name, status
       FROM tenants WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const tenant = rows[0];
    // No password_hash yet means staff hasn't generated portal credentials
    // for this tenant (older records, or created before this feature) —
    // treat identically to a wrong password rather than a different error,
    // so the login form can't be used to enumerate which tenants exist.
    if (!tenant || !tenant.password_hash || tenant.status === 'moved_out') {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await bcrypt.compare(password, tenant.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    if (tenant.status === 'invited') {
      await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [tenant.id]);
      tenant.status = 'active';
    }

    req.session.tenant = {
      id: tenant.id, email: tenant.email, name: tenant.name,
      organizationId: tenant.organization_id, unitId: tenant.unit_id,
    };
    res.json({ tenant: { id: tenant.id, email: tenant.email, name: tenant.name, status: tenant.status } });
  } catch (err) {
    console.error('tenant login error:', err);
    res.status(500).json({ error: 'Something went wrong logging you in.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', requireTenantAuth, (req, res) => {
  res.json({ tenant: req.session.tenant });
});

module.exports = router;
