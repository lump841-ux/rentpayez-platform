'use strict';
const express = require('express');
const db = require('../services/db');
const { requireTenantAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireTenantAuth);

// A tenant can only ever read/touch their own record — every query below
// is scoped by req.session.tenant.id (from the session, never the client)
// AND organization_id, matching the isolation pattern used for staff.
router.get('/me', async (req, res) => {
  const t = req.session.tenant;
  const { rows } = await db.query(
    `SELECT te.id, te.name, te.email, te.phone, te.status,
            u.id AS unit_id, u.unit_number, u.monthly_rent,
            p.id AS property_id, p.name AS property_name, p.address AS property_address,
            b.id AS building_id, b.name AS building_name,
            o.name AS organization_name, o.emergency_contact_name,
            o.emergency_contact_phone, o.emergency_instructions
     FROM tenants te
     JOIN organizations o ON o.id = te.organization_id
     LEFT JOIN units u ON u.id = te.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     LEFT JOIN buildings b ON b.id = u.building_id
     WHERE te.id = $1 AND te.organization_id = $2`,
    [t.id, t.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant record not found' });
  res.json(rows[0]);
});

// Self-service contact info update — intentionally limited to phone only.
// Name/email/unit changes stay staff-controlled since they affect billing
// and identity, not just how to reach someone.
router.patch('/me', async (req, res) => {
  const { phone } = req.body || {};
  const { rows } = await db.query(
    `UPDATE tenants SET phone = $1 WHERE id = $2 AND organization_id = $3
     RETURNING id, name, email, phone, status`,
    [phone ? String(phone).trim() : null, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant record not found' });
  res.json(rows[0]);
});

module.exports = router;
