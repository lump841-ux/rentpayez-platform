'use strict';
const express = require('express');
const crypto  = require('crypto');
const db = require('../services/db');
const { requireTenantAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireTenantAuth);

// Stripe is optional — the org must set STRIPE_SECRET_KEY themselves
// (Render dashboard -> Environment) before online payments work. Every
// route below degrades to a clear 503 instead of crashing if it's unset.
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

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

// ═══════════════════════════════ MAINTENANCE REQUESTS ═══════════════════════════════
router.post('/maintenance-requests', async (req, res) => {
  const { category, priority, description } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: 'description is required' });

  const t = req.session.tenant;
  let propertyId = null;
  if (t.unitId) {
    const { rows } = await db.query(`SELECT property_id FROM units WHERE id = $1`, [t.unitId]);
    if (rows.length) propertyId = rows[0].property_id;
  }

  const { rows } = await db.query(
    `INSERT INTO maintenance_requests (organization_id, tenant_id, unit_id, property_id, category, priority, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [t.organizationId, t.id, t.unitId || null, propertyId, category || 'other', priority || 'normal', description.trim()]
  );
  res.json(rows[0]);
});

router.get('/maintenance-requests', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM maintenance_requests WHERE tenant_id = $1 AND organization_id = $2 ORDER BY created_at DESC`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  res.json(rows);
});

// ═══════════════════════════════ DOCUMENTS (digital lease / e-sign) ═══════════════════════════════
router.get('/documents', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, doc_type, file_name, file_mime, requires_signature, status, signed_name, signed_at, created_at
     FROM documents WHERE tenant_id = $1 AND organization_id = $2 ORDER BY created_at DESC`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  res.json(rows);
});

router.get('/documents/:id/file', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND organization_id = $3`,
    [req.params.id, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  res.setHeader('Content-Type', rows[0].file_mime);
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].file_name}"`);
  res.send(Buffer.from(rows[0].file_data, 'base64'));
});

// Lightweight typed-name e-signature: NOT DocuSign. Records the name the
// tenant typed, plus a timestamp and IP as an audit trail — good enough
// for internal record-keeping, not a substitute for a real e-signature
// vendor if the org needs one that's independently legally certified.
router.post('/documents/:id/sign', async (req, res) => {
  const { signedName } = req.body || {};
  if (!signedName || !signedName.trim()) return res.status(400).json({ error: 'signedName is required' });

  const { rows: existing } = await db.query(
    `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2 AND organization_id = $3`,
    [req.params.id, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!existing.length) return res.status(404).json({ error: 'Document not found' });
  if (!existing[0].requires_signature) return res.status(400).json({ error: 'This document does not require a signature' });
  if (existing[0].status === 'signed') return res.status(400).json({ error: 'Already signed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const { rows } = await db.query(
    `UPDATE documents SET status = 'signed', signed_name = $1, signed_at = now(), signed_ip = $2
     WHERE id = $3
     RETURNING id, title, doc_type, file_name, requires_signature, status, signed_name, signed_at`,
    [signedName.trim(), ip, req.params.id]
  );
  res.json(rows[0]);
});

// ═══════════════════════════════ PAYMENTS / RENT (Stripe) ═══════════════════════════════
router.get('/payments', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, amount_cents, method, status, receipt_number, memo, paid_at, created_at
     FROM payments WHERE tenant_id = $1 AND organization_id = $2 ORDER BY paid_at DESC`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  res.json(rows);
});

// Creates a Stripe Checkout session for this month's rent (or a custom
// amount) and returns the URL to redirect the tenant's browser to.
router.post('/payments/checkout', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Online payments are not set up yet — the org needs to add a STRIPE_SECRET_KEY.' });

  const t = req.session.tenant;
  const { rows } = await db.query(
    `SELECT u.monthly_rent, u.unit_number, p.name AS property_name
     FROM tenants te LEFT JOIN units u ON u.id = te.unit_id LEFT JOIN properties p ON p.id = u.property_id
     WHERE te.id = $1`,
    [t.id]
  );
  const info = rows[0] || {};
  const amountOverride = req.body && req.body.amount;
  const amountCents = amountOverride
    ? Math.round(Number(amountOverride) * 100)
    : Math.round(Number(info.monthly_rent || 0) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'No rent amount is set for your unit — ask your property manager to set one, or enter a custom amount.' });

  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: { name: `Rent — ${info.property_name || 'your unit'}${info.unit_number ? ' #' + info.unit_number : ''}` },
      },
      quantity: 1,
    }],
    metadata: { tenantId: t.id, organizationId: t.organizationId, unitId: t.unitId || '' },
    success_url: `${origin}/tenant/portal.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/tenant/portal.html?payment=cancelled`,
  });
  res.json({ url: session.url });
});

// Called when the tenant portal loads back from Stripe with ?session_id=.
// Verifies the session server-side (never trusts the redirect alone) and
// records the payment the first time it sees a given session_id.
router.get('/payments/confirm', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Online payments are not set up yet.' });
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const session = await stripe.checkout.sessions.retrieve(session_id);
  if (!session || session.metadata.tenantId !== req.session.tenant.id) {
    return res.status(404).json({ error: 'Checkout session not found' });
  }
  if (session.payment_status !== 'paid') {
    return res.json({ status: session.payment_status });
  }

  const { rows: already } = await db.query(`SELECT * FROM payments WHERE stripe_checkout_session_id = $1`, [session_id]);
  if (already.length) return res.json({ status: 'paid', payment: already[0] });

  const receiptNumber = 'RCPT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const t = req.session.tenant;
  const { rows } = await db.query(
    `INSERT INTO payments (organization_id, tenant_id, unit_id, amount_cents, method, status, stripe_checkout_session_id, receipt_number, paid_at)
     VALUES ($1, $2, $3, $4, 'stripe', 'paid', $5, $6, now()) RETURNING *`,
    [t.organizationId, t.id, t.unitId || null, session.amount_total, session_id, receiptNumber]
  );
  res.json({ status: 'paid', payment: rows[0] });
});

module.exports = router;
