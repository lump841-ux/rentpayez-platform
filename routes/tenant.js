'use strict';
const express = require('express');
const crypto  = require('crypto');
const db = require('../services/db');
const { requireTenantAuth } = require('../middleware/auth');
const { rentReminderStatus } = require('../services/reminders');

const router = express.Router();
router.use(requireTenantAuth);

// Builds "$2, $3, $4..." style placeholders for a dynamic IN (...) clause,
// starting at paramIndex. Mirrors the same helper in routes/orgs.js.
function inPlaceholders(arr, paramIndex) {
  return arr.map((_, i) => `$${paramIndex + i}`).join(', ');
}

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
    `SELECT te.id, te.name, te.email, te.phone, te.status, (te.avatar_data IS NOT NULL) AS has_avatar,
            u.id AS unit_id, u.unit_number, u.monthly_rent, u.rent_due_day,
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
  const row = rows[0];

  // Kept as a separate query rather than a correlated EXISTS in the SELECT
  // list above — simpler to reason about and avoids row-multiplication
  // bugs if a JOIN were used instead. Month boundaries are computed here
  // in JS (rather than SQL date_trunc) so this works identically against
  // both real Postgres and the pg-mem test adapter, which doesn't
  // implement date_trunc.
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const { rows: paidRows } = await db.query(
    `SELECT 1 FROM payments WHERE tenant_id = $1 AND paid_at >= $2 AND paid_at < $3 LIMIT 1`,
    [t.id, periodStart, periodEnd]
  );
  // In-app only — no email/SMS is sent. Computed from the real due day and
  // whether a payment is already on file for the current calendar month.
  row.rent_reminder = rentReminderStatus(row.rent_due_day, paidRows.length > 0);
  res.json(row);
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

// Profile photo — self-service, base64 in JSON like every other photo in
// this app. Capped smaller than the maintenance/inspection photo limits
// since an avatar is rendered small everywhere (sidebar, admin tenant
// list); the portal should downsize before upload regardless. Mime is
// restricted to image/* here specifically because avatars are always
// rendered via <img src>, unlike maintenance/inspection photos which are
// proof documents opened on demand.
const MAX_AVATAR_BASE64_CHARS = 3 * 1024 * 1024; // ~2.2MB decoded

router.patch('/me/avatar', async (req, res) => {
  const { avatarBase64, avatarMime } = req.body || {};
  if (!avatarBase64 || !avatarMime) return res.status(400).json({ error: 'avatarBase64 and avatarMime are required' });
  if (!avatarMime.startsWith('image/')) return res.status(400).json({ error: 'avatarMime must be an image type' });
  if (avatarBase64.length > MAX_AVATAR_BASE64_CHARS) return res.status(400).json({ error: 'Photo is too large' });

  const { rows } = await db.query(
    `UPDATE tenants SET avatar_data = $1, avatar_mime = $2 WHERE id = $3 AND organization_id = $4
     RETURNING id, name, email, phone, status, (avatar_data IS NOT NULL) AS has_avatar`,
    [avatarBase64, avatarMime, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant record not found' });
  res.json(rows[0]);
});

router.delete('/me/avatar', async (req, res) => {
  const { rows } = await db.query(
    `UPDATE tenants SET avatar_data = NULL, avatar_mime = NULL WHERE id = $1 AND organization_id = $2
     RETURNING id, name, email, phone, status, (avatar_data IS NOT NULL) AS has_avatar`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant record not found' });
  res.json(rows[0]);
});

router.get('/me/avatar', async (req, res) => {
  const { rows } = await db.query(
    `SELECT avatar_data, avatar_mime FROM tenants WHERE id = $1 AND organization_id = $2`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length || !rows[0].avatar_data) return res.status(404).json({ error: 'No photo set' });
  res.setHeader('Content-Type', rows[0].avatar_mime);
  res.send(Buffer.from(rows[0].avatar_data, 'base64'));
});

// ═══════════════════════════════ MAINTENANCE REQUESTS ═══════════════════════════════
// Photos are optional proof-of-issue, sent as base64 in the JSON body
// (small images only — the tenant portal downsizes before upload) rather
// than multipart, so the existing single JSON POST route can handle both
// with-photo and without-photo submissions the same way.
const MAX_PHOTO_BASE64_CHARS = 6 * 1024 * 1024; // ~4.5MB decoded, generous for a downsized photo

router.post('/maintenance-requests', async (req, res) => {
  const { category, priority, description, photoBase64, photoMime } = req.body || {};
  if (!description || !description.trim()) return res.status(400).json({ error: 'description is required' });
  if (photoBase64 && photoBase64.length > MAX_PHOTO_BASE64_CHARS) return res.status(400).json({ error: 'Photo is too large' });
  if (photoBase64 && !photoMime) return res.status(400).json({ error: 'photoMime is required when photoBase64 is provided' });

  const t = req.session.tenant;
  let propertyId = null;
  if (t.unitId) {
    const { rows } = await db.query(`SELECT property_id FROM units WHERE id = $1`, [t.unitId]);
    if (rows.length) propertyId = rows[0].property_id;
  }

  const { rows } = await db.query(
    `INSERT INTO maintenance_requests (organization_id, tenant_id, unit_id, property_id, category, priority, description, photo_data, photo_mime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, organization_id, tenant_id, unit_id, property_id, category, priority, description, status, staff_notes, created_at, updated_at, resolved_at,
               (photo_data IS NOT NULL) AS has_photo`,
    [t.organizationId, t.id, t.unitId || null, propertyId, category || 'other', priority || 'normal', description.trim(),
     photoBase64 || null, photoBase64 ? photoMime : null]
  );
  res.json(rows[0]);
});

router.get('/maintenance-requests', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, organization_id, tenant_id, unit_id, property_id, category, priority, description, status, staff_notes,
            created_at, updated_at, resolved_at, (photo_data IS NOT NULL) AS has_photo
     FROM maintenance_requests WHERE tenant_id = $1 AND organization_id = $2 ORDER BY created_at DESC`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  res.json(rows);
});

router.get('/maintenance-requests/:id/photo', async (req, res) => {
  const { rows } = await db.query(
    `SELECT photo_data, photo_mime FROM maintenance_requests WHERE id = $1 AND tenant_id = $2 AND organization_id = $3`,
    [req.params.id, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length || !rows[0].photo_data) return res.status(404).json({ error: 'No photo on this request' });
  res.setHeader('Content-Type', rows[0].photo_mime);
  res.send(Buffer.from(rows[0].photo_data, 'base64'));
});

// ═══════════════════════════════ INSPECTIONS (read-only) ═══════════════════════════════
// Staff conduct these from the console; tenants can only view their own
// unit's history, never create or edit one — this is not an area where a
// tenant should be able to influence the record.
router.get('/inspections', async (req, res) => {
  const t = req.session.tenant;
  const { rows } = await db.query(
    `SELECT i.id, i.organization_id, i.tenant_id, i.unit_id, i.property_id, i.inspection_type, i.overall_notes, i.created_at
     FROM inspections i
     WHERE i.organization_id = $1 AND (i.tenant_id = $2 OR i.unit_id = $3)
     ORDER BY i.created_at DESC`,
    [t.organizationId, t.id, t.unitId || null]
  );
  if (!rows.length) return res.json([]);

  // Separate query + JS merge instead of a correlated subquery — see
  // routes/orgs.js GET /inspections for the same fix and rationale.
  const inspectionIds = rows.map(r => r.id);
  const { rows: counts } = await db.query(
    `SELECT inspection_id, COUNT(*) AS item_count FROM inspection_items
     WHERE inspection_id IN (${inPlaceholders(inspectionIds, 1)}) GROUP BY inspection_id`,
    inspectionIds
  );
  const countMap = new Map(counts.map(c => [c.inspection_id, Number(c.item_count)]));
  res.json(rows.map(r => ({ ...r, item_count: countMap.get(r.id) || 0 })));
});

router.get('/inspections/:id', async (req, res) => {
  const t = req.session.tenant;
  const { rows } = await db.query(
    `SELECT i.* FROM inspections i
     WHERE i.id = $1 AND i.organization_id = $2 AND (i.tenant_id = $3 OR i.unit_id = $4)`,
    [req.params.id, t.organizationId, t.id, t.unitId || null]
  );
  if (!rows.length) return res.status(404).json({ error: 'Inspection not found' });

  const { rows: items } = await db.query(
    `SELECT id, inspection_id, room, condition, notes, created_at, (photo_data IS NOT NULL) AS has_photo
     FROM inspection_items WHERE inspection_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json({ ...rows[0], items });
});

router.get('/inspections/:id/items/:itemId/photo', async (req, res) => {
  const t = req.session.tenant;
  const { rows } = await db.query(
    `SELECT ii.photo_data, ii.photo_mime, i.organization_id, i.tenant_id, i.unit_id
     FROM inspection_items ii JOIN inspections i ON i.id = ii.inspection_id
     WHERE ii.id = $1 AND ii.inspection_id = $2`,
    [req.params.itemId, req.params.id]
  );
  if (!rows.length || !rows[0].photo_data) return res.status(404).json({ error: 'No photo on this item' });
  const row = rows[0];
  if (row.organization_id !== t.organizationId || (row.tenant_id !== t.id && row.unit_id !== t.unitId)) {
    return res.status(404).json({ error: 'No photo on this item' });
  }
  res.setHeader('Content-Type', rows[0].photo_mime);
  res.send(Buffer.from(rows[0].photo_data, 'base64'));
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

// ═══════════════════════════════ MY GOALS ═══════════════════════════════
// Real, tenant-editable goals — not the demo "mortgage roadmap" numbers
// from the original rentpayez.html mockup. Nothing here is auto-derived
// from a credit score, since no bureau integration exists yet.
router.get('/goals', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM goals WHERE tenant_id = $1 AND organization_id = $2 ORDER BY created_at ASC`,
    [req.session.tenant.id, req.session.tenant.organizationId]
  );
  res.json(rows);
});

router.post('/goals', async (req, res) => {
  const { title, targetNote } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
  const { rows } = await db.query(
    `INSERT INTO goals (organization_id, tenant_id, title, target_note) VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.session.tenant.organizationId, req.session.tenant.id, title.trim(), targetNote ? targetNote.trim() : null]
  );
  res.json(rows[0]);
});

router.patch('/goals/:id', async (req, res) => {
  const { progressPct, status, title, targetNote } = req.body || {};
  if (progressPct != null && (progressPct < 0 || progressPct > 100)) return res.status(400).json({ error: 'progressPct must be between 0 and 100' });
  if (status && !['in_progress', 'done'].includes(status)) return res.status(400).json({ error: 'status must be in_progress or done' });

  const { rows } = await db.query(
    `UPDATE goals SET
       progress_pct = COALESCE($1, progress_pct),
       status = COALESCE($2, status),
       title = COALESCE($3, title),
       target_note = COALESCE($4, target_note),
       updated_at = now()
     WHERE id = $5 AND tenant_id = $6 AND organization_id = $7 RETURNING *`,
    [progressPct != null ? progressPct : null, status || null, title ? title.trim() : null,
     targetNote != null ? targetNote.trim() : null, req.params.id, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Goal not found' });
  res.json(rows[0]);
});

router.delete('/goals/:id', async (req, res) => {
  const { rows } = await db.query(
    `DELETE FROM goals WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 RETURNING id`,
    [req.params.id, req.session.tenant.id, req.session.tenant.organizationId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Goal not found' });
  res.json({ ok: true });
});

// ═══════════════════════════════ AI COACH ═══════════════════════════════
// Real LLM-backed chat, grounded in the tenant's actual data (name, unit,
// payment history, open goals) — never a fabricated credit score, since
// no bureau integration exists. Supports either ANTHROPIC_API_KEY or
// OPENAI_API_KEY (whichever the org sets); degrades to a clear 503,
// matching the Stripe pattern, if neither is configured.
async function callAnthropic(systemPrompt, history, message) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_COACH_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: [...history, { role: 'user', content: message }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || 'Anthropic API error');
  return data.content.map(b => b.text || '').join('').trim();
}

async function callOpenAI(systemPrompt, history, message) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_COACH_MODEL || 'gpt-4o-mini',
      max_tokens: 500,
      messages: [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: message }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message || 'OpenAI API error');
  return (data.choices[0].message.content || '').trim();
}

router.post('/coach/message', async (req, res) => {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasAnthropic && !hasOpenAI) {
    return res.status(503).json({ error: "Coach isn't set up yet — the org needs to add an ANTHROPIC_API_KEY or OPENAI_API_KEY." });
  }

  const { message, history } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });
  const safeHistory = Array.isArray(history)
    ? history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-10)
    : [];

  const t = req.session.tenant;
  const [{ rows: payRows }, { rows: goalRows }, { rows: unitRows }] = await Promise.all([
    db.query(`SELECT amount_cents, paid_at FROM payments WHERE tenant_id = $1 ORDER BY paid_at DESC LIMIT 12`, [t.id]),
    db.query(`SELECT title, target_note, progress_pct, status FROM goals WHERE tenant_id = $1 ORDER BY created_at ASC`, [t.id]),
    db.query(`SELECT u.monthly_rent, u.unit_number, p.name AS property_name FROM tenants te LEFT JOIN units u ON u.id = te.unit_id LEFT JOIN properties p ON p.id = u.property_id WHERE te.id = $1`, [t.id]),
  ]);
  const unit = unitRows[0] || {};

  const systemPrompt = `You are Coach Ezra, a friendly personal-finance and rent coach inside the rentpayez tenant portal. You're talking to ${t.name}.
Real data you know about them:
- Unit: ${unit.unit_number ? `#${unit.unit_number} at ${unit.property_name || 'their property'}` : 'not yet assigned to a unit'}
- Monthly rent: ${unit.monthly_rent ? `$${unit.monthly_rent}` : 'not on file'}
- Recent payments on file: ${payRows.length ? payRows.map(p => `$${(p.amount_cents / 100).toFixed(2)} on ${new Date(p.paid_at).toLocaleDateString()}`).join('; ') : 'none yet'}
- Their goals: ${goalRows.length ? goalRows.map(g => `"${g.title}" (${g.progress_pct}% — ${g.status})`).join('; ') : 'none set yet'}

IMPORTANT: rentpayez does not currently have a credit bureau integration connected for this tenant. You do NOT know their actual credit score, and must never invent one or state a specific score number. If asked about their credit score, say honestly that it isn't connected yet, and instead give general, accurate personal-finance guidance (on-time payment habits, utilization, budgeting). Be warm, concise, and practical. Keep replies to a few short paragraphs.`;

  try {
    const reply = hasAnthropic
      ? await callAnthropic(systemPrompt, safeHistory, message.trim())
      : await callOpenAI(systemPrompt, safeHistory, message.trim());
    res.json({ reply });
  } catch (err) {
    console.error('coach/message error:', err.message);
    res.status(502).json({ error: 'Coach Ezra is having trouble responding right now — try again in a moment.' });
  }
});

module.exports = router;
