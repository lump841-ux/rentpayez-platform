'use strict';
const db = require('../services/db');

// ── Session guard ─────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Role guard ────────────────────────────────────────────────────────
// Usage: requireRole('org_admin', 'branch_manager')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions for this action' });
    next();
  };
}

// ── Organization scoping ─────────────────────────────────────────────
// Attaches req.orgId from the session (never trusts a client-sent org id),
// and 404s (not 403 — don't reveal existence) if a super_admin didn't
// explicitly pick one via ?organizationId= for cross-org platform routes.
function requireOrgScope(req, res, next) {
  const u = req.session.user;
  if (u.role === 'super_admin') {
    // Platform super admin may operate across orgs, but must say which one.
    const orgId = req.query.organizationId || req.body.organizationId;
    if (!orgId) return res.status(400).json({ error: 'organizationId is required for platform admin requests' });
    req.orgId = orgId;
  } else {
    req.orgId = u.organizationId;
  }
  next();
}

// ── Branch/property-level scoping ────────────────────────────────────
// For roles below org_admin, resolves which property_ids they're allowed
// to touch, based on staff_assignments (a branch assignment expands to
// every property currently under that branch). org_admin and super_admin
// get null (meaning "no restriction beyond organization_id").
async function scopedPropertyIds(user) {
  if (user.role === 'org_admin' || user.role === 'super_admin') return null;

  const { rows: assignments } = await db.query(
    'SELECT branch_id, property_id FROM staff_assignments WHERE organization_user_id = $1',
    [user.id]
  );
  if (!assignments.length) return []; // assigned to nothing yet — sees nothing

  const directPropertyIds = assignments.filter(a => a.property_id).map(a => a.property_id);
  const branchIds = assignments.filter(a => a.branch_id).map(a => a.branch_id);

  let branchPropertyIds = [];
  if (branchIds.length) {
    // Built as a dynamic IN (...) with individual placeholders rather than
    // `= ANY($1::uuid[])` — functionally identical on real Postgres, but
    // portable across driver/pooling layers that don't handle array binds.
    const placeholders = branchIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await db.query(
      `SELECT id FROM properties WHERE branch_id IN (${placeholders})`,
      branchIds
    );
    branchPropertyIds = rows.map(r => r.id);
  }
  return [...new Set([...directPropertyIds, ...branchPropertyIds])];
}

// ── Tenant session guard ─────────────────────────────────────────────
// Tenants are a separate identity from staff (organization_users) — they
// log in through /api/tenant-auth and get req.session.tenant, never
// req.session.user, so a tenant session can never touch staff-only routes.
function requireTenantAuth(req, res, next) {
  if (!req.session || !req.session.tenant) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

module.exports = { requireAuth, requireRole, requireOrgScope, scopedPropertyIds, requireTenantAuth };
