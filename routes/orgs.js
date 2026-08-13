'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../services/db');
const { requireAuth, requireRole, requireOrgScope, scopedPropertyIds } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth, requireOrgScope);

// Builds "$2, $3, $4..." style placeholders for a dynamic IN (...) clause,
// starting at paramIndex. Used instead of `= ANY($n::uuid[])` for
// portability across driver/pooling layers that don't handle array binds.
function inPlaceholders(arr, paramIndex) {
  return arr.map((_, i) => `$${paramIndex + i}`).join(', ');
}

async function logAction(req, action, targetType, targetId, metadata) {
  await db.query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
     VALUES ($1, $2, 'organization_user', $3, $4, $5, $6)`,
    [req.orgId, req.session.user.id, action, targetType, targetId || null, JSON.stringify(metadata || {})]
  );
}

// ═══════════════════════════════ BRANCHES ═══════════════════════════════
router.post('/branches', requireRole('org_admin', 'super_admin'), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    `INSERT INTO branches (organization_id, name) VALUES ($1, $2) RETURNING *`,
    [req.orgId, name]
  );
  await logAction(req, 'branch.create', 'branch', rows[0].id, { name });
  res.json(rows[0]);
});

router.get('/branches', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);
  if (scope === null) {
    const { rows } = await db.query(`SELECT * FROM branches WHERE organization_id = $1 ORDER BY name`, [req.orgId]);
    return res.json(rows);
  }
  if (scope.length === 0) return res.json([]);
  // Scoped staff only see branches that have at least one property they're
  // allowed to touch (a branch_manager's own branch expands to this via
  // scopedPropertyIds already; a property_manager sees just their branch, if any).
  const { rows } = await db.query(
    `SELECT DISTINCT b.* FROM branches b
     JOIN properties p ON p.branch_id = b.id
     WHERE b.organization_id = $1 AND p.id IN (${inPlaceholders(scope, 2)})
     ORDER BY b.name`,
    [req.orgId, ...scope]
  );
  res.json(rows);
});

// ═══════════════════════════════ PROPERTIES ═══════════════════════════════
router.post('/properties', requireRole('org_admin', 'branch_manager', 'super_admin'), async (req, res) => {
  const { name, address, branchId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    `INSERT INTO properties (organization_id, branch_id, name, address) VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.orgId, branchId || null, name, address || null]
  );
  await logAction(req, 'property.create', 'property', rows[0].id, { name });
  res.json(rows[0]);
});

router.get('/properties', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);
  const { rows } = scope === null
    ? await db.query(`SELECT * FROM properties WHERE organization_id = $1 ORDER BY name`, [req.orgId])
    : await db.query(
        `SELECT * FROM properties WHERE organization_id = $1 AND id IN (${inPlaceholders(scope, 2)}) ORDER BY name`,
        [req.orgId, ...scope]
      );
  res.json(rows);
});

// ═══════════════════════════════ BUILDINGS ═══════════════════════════════
router.post('/buildings', requireRole('org_admin', 'branch_manager', 'property_manager', 'super_admin'), async (req, res) => {
  const { name, propertyId } = req.body || {};
  if (!name || !propertyId) return res.status(400).json({ error: 'name and propertyId are required' });
  const { rows } = await db.query(
    `INSERT INTO buildings (organization_id, property_id, name) VALUES ($1, $2, $3) RETURNING *`,
    [req.orgId, propertyId, name]
  );
  await logAction(req, 'building.create', 'building', rows[0].id, { name });
  res.json(rows[0]);
});

router.get('/buildings', async (req, res) => {
  const { propertyId } = req.query;
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);
  if (scope !== null && propertyId && !scope.includes(propertyId)) return res.json([]);

  if (scope === null) {
    const params = propertyId ? [req.orgId, propertyId] : [req.orgId];
    const { rows } = await db.query(
      `SELECT * FROM buildings WHERE organization_id = $1 ${propertyId ? 'AND property_id = $2' : ''} ORDER BY name`,
      params
    );
    return res.json(rows);
  }

  const ids = propertyId ? [propertyId] : scope;
  const { rows } = await db.query(
    `SELECT * FROM buildings WHERE organization_id = $1 AND property_id IN (${inPlaceholders(ids, 2)}) ORDER BY name`,
    [req.orgId, ...ids]
  );
  res.json(rows);
});

// ═══════════════════════════════ UNITS ═══════════════════════════════
router.post('/units', requireRole('org_admin', 'branch_manager', 'property_manager', 'super_admin'), async (req, res) => {
  const { unitNumber, propertyId, buildingId, monthlyRent } = req.body || {};
  if (!unitNumber || !propertyId) return res.status(400).json({ error: 'unitNumber and propertyId are required' });
  const { rows } = await db.query(
    `INSERT INTO units (organization_id, property_id, building_id, unit_number, monthly_rent)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.orgId, propertyId, buildingId || null, unitNumber, monthlyRent || null]
  );
  await logAction(req, 'unit.create', 'unit', rows[0].id, { unitNumber });
  res.json(rows[0]);
});

router.get('/units', async (req, res) => {
  const { propertyId } = req.query;
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);
  if (scope !== null && propertyId && !scope.includes(propertyId)) return res.json([]); // asked for a property outside their scope

  if (scope === null) {
    const params = propertyId ? [req.orgId, propertyId] : [req.orgId];
    const { rows } = await db.query(
      `SELECT * FROM units WHERE organization_id = $1 ${propertyId ? 'AND property_id = $2' : ''} ORDER BY unit_number`,
      params
    );
    return res.json(rows);
  }

  // Scoped staff (below org_admin): restrict to properties they're assigned to,
  // whether or not a specific propertyId was requested.
  const ids = propertyId ? [propertyId] : scope;
  const { rows } = await db.query(
    `SELECT * FROM units WHERE organization_id = $1 AND property_id IN (${inPlaceholders(ids, 2)}) ORDER BY unit_number`,
    [req.orgId, ...ids]
  );
  res.json(rows);
});

// ═══════════════════════════════ STAFF ═══════════════════════════════
const VALID_ROLES = [
  'org_admin', 'branch_manager', 'property_manager',
  'maintenance_supervisor', 'maintenance_tech', 'inspector', 'office_staff',
];

router.post('/staff/invite', requireRole('org_admin', 'super_admin'), async (req, res) => {
  const { email, name, role } = req.body || {};
  if (!email || !name || !role) return res.status(400).json({ error: 'email, name, and role are required' });
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });

  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 12);
  const inviteToken = crypto.randomBytes(24).toString('hex');

  try {
    const { rows } = await db.query(
      `INSERT INTO organization_users (organization_id, email, password_hash, name, role, status, invite_token)
       VALUES ($1, $2, $3, $4, $5, 'invited', $6)
       RETURNING id, email, name, role, status`,
      [req.orgId, email.toLowerCase().trim(), hash, name, role, inviteToken]
    );
    await logAction(req, 'staff.invite', 'organization_user', rows[0].id, { email, role });
    // NOTE: no email service configured yet — see SETUP-NOTIFICATIONS.md.
    // In the meantime, the invite token/temp password are returned directly
    // so staff can be invited "manually" until email is wired up.
    res.json({ staff: rows[0], inviteToken, tempPassword });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email is already part of this organization.' });
    throw err;
  }
});

router.get('/staff', requireRole('org_admin', 'branch_manager', 'property_manager', 'super_admin'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, email, name, role, status, created_at FROM organization_users WHERE organization_id = $1 ORDER BY name`,
    [req.orgId]
  );
  res.json(rows);
});

router.post('/staff/:id/assign', requireRole('org_admin', 'super_admin'), async (req, res) => {
  const { branchId, propertyId } = req.body || {};
  if (!branchId && !propertyId) return res.status(400).json({ error: 'branchId or propertyId is required' });

  const { rows: staffRows } = await db.query(
    `SELECT id FROM organization_users WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!staffRows.length) return res.status(404).json({ error: 'Staff member not found in this organization' });

  const { rows } = await db.query(
    `INSERT INTO staff_assignments (organization_user_id, branch_id, property_id) VALUES ($1, $2, $3) RETURNING *`,
    [req.params.id, branchId || null, propertyId || null]
  );
  await logAction(req, 'staff.assign', 'organization_user', req.params.id, { branchId, propertyId });
  res.json(rows[0]);
});

// ═══════════════════════════════ TENANTS ═══════════════════════════════
// Every tenant gets a portal login the moment they're created — same
// "no email service yet, temp password comes back in the API/UI response"
// pattern used for staff invites (see /staff/invite above). The tenant
// portal lives at /tenant/login.html and only ever shows that one tenant
// their own unit — see routes/tenant.js.
router.post('/tenants', requireRole('org_admin', 'branch_manager', 'property_manager', 'office_staff', 'super_admin'), async (req, res) => {
  const { name, email, phone, unitId } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 12);
  try {
    const { rows } = await db.query(
      `INSERT INTO tenants (organization_id, unit_id, name, email, phone, password_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'invited') RETURNING *`,
      [req.orgId, unitId || null, name, email.toLowerCase().trim(), phone || null, hash]
    );
    await logAction(req, 'tenant.create', 'tenant', rows[0].id, { name, email });
    const { password_hash, ...tenant } = rows[0];
    res.json({ ...tenant, tempPassword });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A tenant with that email already exists in this organization.' });
    throw err;
  }
});

// Generates a fresh portal password for a tenant who doesn't have one yet
// (older records) or who lost theirs — same manual hand-off pattern as
// creation, since there's no email service to send it automatically.
router.post('/tenants/:id/reset-password', requireRole('org_admin', 'branch_manager', 'property_manager', 'office_staff', 'super_admin'), async (req, res) => {
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 12);
  const { rows } = await db.query(
    `UPDATE tenants SET password_hash = $1 WHERE id = $2 AND organization_id = $3 RETURNING id, name, email`,
    [hash, req.params.id, req.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant not found in this organization' });
  await logAction(req, 'tenant.reset_password', 'tenant', rows[0].id, {});
  res.json({ tenant: rows[0], tempPassword });
});

router.get('/tenants', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);
  const { rows } = scope === null
    ? await db.query(
        `SELECT t.* FROM tenants t WHERE t.organization_id = $1 ORDER BY t.name`,
        [req.orgId]
      )
    : await db.query(
        `SELECT t.* FROM tenants t
         JOIN units u ON u.id = t.unit_id
         WHERE t.organization_id = $1 AND u.property_id IN (${inPlaceholders(scope, 2)}) ORDER BY t.name`,
        [req.orgId, ...scope]
      );
  res.json(rows);
});

router.post('/tenants/:id/assign-unit', requireRole('org_admin', 'branch_manager', 'property_manager', 'office_staff', 'super_admin'), async (req, res) => {
  const { unitId } = req.body || {};
  if (!unitId) return res.status(400).json({ error: 'unitId is required' });
  const { rows: unitRows } = await db.query(`SELECT id FROM units WHERE id = $1 AND organization_id = $2`, [unitId, req.orgId]);
  if (!unitRows.length) return res.status(404).json({ error: 'Unit not found in this organization' });

  const { rows } = await db.query(
    `UPDATE tenants SET unit_id = $1 WHERE id = $2 AND organization_id = $3 RETURNING *`,
    [unitId, req.params.id, req.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Tenant not found in this organization' });
  await logAction(req, 'tenant.assign_unit', 'tenant', req.params.id, { unitId });
  res.json(rows[0]);
});

// CSV columns expected: name,email,phone,unit_number
// unit_number is matched against units.unit_number within this organization
// (across all properties) — ambiguous matches are skipped and reported.
router.post('/tenants/import-csv', requireRole('org_admin', 'branch_manager', 'property_manager', 'super_admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name "file")' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse CSV: ' + err.message });
  }

  const results = { created: 0, skipped: [], errors: [], credentials: [] };
  for (const [i, row] of records.entries()) {
    const rowNum = i + 2; // +1 for header, +1 for 1-index
    const name = row.name && row.name.trim();
    const email = row.email && row.email.trim().toLowerCase();
    if (!name || !email) { results.errors.push({ row: rowNum, error: 'Missing name or email' }); continue; }

    let unitId = null;
    if (row.unit_number) {
      const { rows: units } = await db.query(
        `SELECT id FROM units WHERE organization_id = $1 AND unit_number = $2`,
        [req.orgId, row.unit_number.trim()]
      );
      if (units.length === 1) unitId = units[0].id;
      else if (units.length > 1) { results.skipped.push({ row: rowNum, reason: `unit_number "${row.unit_number}" is ambiguous (matches ${units.length} units) — tenant created without a unit assignment` }); }
      else { results.skipped.push({ row: rowNum, reason: `unit_number "${row.unit_number}" not found — tenant created without a unit assignment` }); }
    }

    try {
      const tempPassword = crypto.randomBytes(9).toString('base64url');
      const hash = await bcrypt.hash(tempPassword, 12);
      await db.query(
        `INSERT INTO tenants (organization_id, unit_id, name, email, phone, password_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'invited')`,
        [req.orgId, unitId, name, email, row.phone ? row.phone.trim() : null, hash]
      );
      results.created++;
      results.credentials.push({ row: rowNum, name, email, tempPassword });
    } catch (err) {
      if (err.code === '23505') results.errors.push({ row: rowNum, error: `Tenant with email ${email} already exists` });
      else results.errors.push({ row: rowNum, error: err.message });
    }
  }

  await logAction(req, 'tenant.import_csv', 'tenant', null, { created: results.created, errorCount: results.errors.length });
  res.json(results);
});

// ═══════════════════════════════ BULK PORTFOLIO IMPORT ═══════════════════════════════
// Lets an org admin upload a spreadsheet (CSV) exported from whatever system
// they currently use — column names don't have to match exactly, they're
// matched against a flexible alias dictionary. Two-step flow:
//   1) POST /import/portfolio/preview -> parses headers + a few sample rows,
//      returns a suggested column mapping for the admin to confirm/adjust.
//   2) POST /import/portfolio/commit  -> re-parses the full file with the
//      confirmed mapping and finds-or-creates branches/properties/buildings,
//      then creates units (skipping ones that already exist by unit_number
//      within the same property, so re-uploading the same file is safe).
const IMPORT_FIELDS = [
  { key: 'branch_name',      label: 'Branch / Division',      required: false },
  { key: 'property_name',    label: 'Property / Development',  required: true },
  { key: 'property_address', label: 'Property Address',        required: false },
  { key: 'building_name',    label: 'Building',                required: false },
  { key: 'unit_number',      label: 'Unit Number',             required: true },
  { key: 'monthly_rent',     label: 'Monthly Rent',            required: false },
];

const IMPORT_ALIASES = {
  branch_name:      ['branch', 'division', 'branch name', 'district', 'region', 'branch division'],
  property_name:    ['property', 'development', 'property name', 'project', 'site', 'community', 'property development'],
  property_address: ['address', 'property address', 'street address', 'street', 'location'],
  building_name:    ['building', 'bldg', 'building name', 'building number'],
  unit_number:      ['unit', 'unit number', 'unit no', 'apt', 'apartment', 'apt number', 'apartment number'],
  monthly_rent:     ['rent', 'monthly rent', 'rent amount', 'monthly rent amount'],
};

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Given the raw CSV header row, suggests which header goes with which
// IMPORT_FIELDS key by matching normalized text against the key itself and
// its alias list. Returns { fieldKey: headerNameOrNull, ... }.
function suggestMapping(headers) {
  const normalizedHeaders = headers.map(h => ({ raw: h, norm: normalizeHeader(h) }));
  const mapping = {};
  for (const field of IMPORT_FIELDS) {
    const candidates = [normalizeHeader(field.key.replace(/_/g, ' ')), ...(IMPORT_ALIASES[field.key] || []).map(normalizeHeader)];
    const match = normalizedHeaders.find(h => candidates.includes(h.norm));
    mapping[field.key] = match ? match.raw : null;
  }
  return mapping;
}

router.post('/import/portfolio/preview', requireRole('org_admin', 'super_admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required (field name "file")' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse file: ' + err.message });
  }
  if (!records.length) return res.status(400).json({ error: 'File has no data rows' });

  const headers = Object.keys(records[0]);
  res.json({
    headers,
    fields: IMPORT_FIELDS,
    suggestedMapping: suggestMapping(headers),
    sampleRows: records.slice(0, 5),
    totalRows: records.length,
  });
});

router.post('/import/portfolio/commit', requireRole('org_admin', 'super_admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required (field name "file")' });
  let mapping;
  try {
    mapping = JSON.parse(req.body.mapping || '{}');
  } catch {
    return res.status(400).json({ error: 'mapping must be JSON' });
  }
  if (!mapping.property_name || !mapping.unit_number) {
    return res.status(400).json({ error: 'Property and Unit Number columns must be mapped' });
  }

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return res.status(400).json({ error: 'Could not parse file: ' + err.message });
  }

  const results = { branchesCreated: 0, propertiesCreated: 0, buildingsCreated: 0, unitsCreated: 0, unitsSkipped: 0, errors: [] };
  const branchCache = new Map();   // lowercased name -> id
  const propertyCache = new Map(); // `${branchId||''}::${lowercased name}` -> id
  const buildingCache = new Map(); // `${propertyId}::${lowercased name}` -> id

  async function findOrCreateBranch(name) {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    if (branchCache.has(key)) return branchCache.get(key);
    const { rows: existing } = await db.query(
      `SELECT id FROM branches WHERE organization_id = $1 AND lower(name) = $2`, [req.orgId, key]
    );
    let id;
    if (existing.length) {
      id = existing[0].id;
    } else {
      const { rows } = await db.query(
        `INSERT INTO branches (organization_id, name) VALUES ($1, $2) RETURNING id`, [req.orgId, name.trim()]
      );
      id = rows[0].id;
      results.branchesCreated++;
    }
    branchCache.set(key, id);
    return id;
  }

  async function findOrCreateProperty(name, address, branchId) {
    const key = `${branchId || ''}::${name.trim().toLowerCase()}`;
    if (propertyCache.has(key)) return propertyCache.get(key);
    const { rows: existing } = await db.query(
      `SELECT id FROM properties WHERE organization_id = $1 AND lower(name) = $2 AND coalesce(branch_id::text, '') = coalesce($3::text, '')`,
      [req.orgId, name.trim().toLowerCase(), branchId || null]
    );
    let id;
    if (existing.length) {
      id = existing[0].id;
    } else {
      const { rows } = await db.query(
        `INSERT INTO properties (organization_id, branch_id, name, address) VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.orgId, branchId || null, name.trim(), address ? address.trim() : null]
      );
      id = rows[0].id;
      results.propertiesCreated++;
    }
    propertyCache.set(key, id);
    return id;
  }

  async function findOrCreateBuilding(name, propertyId) {
    if (!name) return null;
    const key = `${propertyId}::${name.trim().toLowerCase()}`;
    if (buildingCache.has(key)) return buildingCache.get(key);
    const { rows: existing } = await db.query(
      `SELECT id FROM buildings WHERE organization_id = $1 AND property_id = $2 AND lower(name) = $3`,
      [req.orgId, propertyId, name.trim().toLowerCase()]
    );
    let id;
    if (existing.length) {
      id = existing[0].id;
    } else {
      const { rows } = await db.query(
        `INSERT INTO buildings (organization_id, property_id, name) VALUES ($1, $2, $3) RETURNING id`,
        [req.orgId, propertyId, name.trim()]
      );
      id = rows[0].id;
      results.buildingsCreated++;
    }
    buildingCache.set(key, id);
    return id;
  }

  for (const [i, row] of records.entries()) {
    const rowNum = i + 2; // +1 for header, +1 for 1-index
    const get = (fieldKey) => {
      const header = mapping[fieldKey];
      return header && row[header] != null ? String(row[header]).trim() : '';
    };
    const propertyName = get('property_name');
    const unitNumber = get('unit_number');
    if (!propertyName || !unitNumber) {
      results.errors.push({ row: rowNum, error: 'Missing property name or unit number' });
      continue;
    }
    try {
      const branchId = await findOrCreateBranch(get('branch_name'));
      const propertyId = await findOrCreateProperty(propertyName, get('property_address'), branchId);
      const buildingId = await findOrCreateBuilding(get('building_name'), propertyId);
      const rentRaw = get('monthly_rent');
      const monthlyRent = rentRaw ? (Number(rentRaw.replace(/[^0-9.]/g, '')) || null) : null;

      const { rows: existingUnit } = await db.query(
        `SELECT id FROM units WHERE organization_id = $1 AND property_id = $2 AND unit_number = $3`,
        [req.orgId, propertyId, unitNumber]
      );
      if (existingUnit.length) {
        results.unitsSkipped++;
      } else {
        await db.query(
          `INSERT INTO units (organization_id, property_id, building_id, unit_number, monthly_rent) VALUES ($1, $2, $3, $4, $5)`,
          [req.orgId, propertyId, buildingId, unitNumber, monthlyRent]
        );
        results.unitsCreated++;
      }
    } catch (err) {
      results.errors.push({ row: rowNum, error: err.message });
    }
  }

  await logAction(req, 'portfolio.import', 'unit', null, {
    unitsCreated: results.unitsCreated, unitsSkipped: results.unitsSkipped,
    propertiesCreated: results.propertiesCreated, branchesCreated: results.branchesCreated,
    buildingsCreated: results.buildingsCreated, errorCount: results.errors.length,
  });
  res.json(results);
});

// ═══════════════════════════════ ORG SUMMARY / ISOLATION CHECK ═══════════════════════════════
router.get('/summary', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);

  if (scope === null) {
    // org_admin / super_admin: unrestricted, org-wide counts.
    const [branches, properties, buildings, units, tenants, staff] = await Promise.all([
      db.query(`SELECT count(*)::int AS c FROM branches WHERE organization_id = $1`, [req.orgId]),
      db.query(`SELECT count(*)::int AS c FROM properties WHERE organization_id = $1`, [req.orgId]),
      db.query(`SELECT count(*)::int AS c FROM buildings WHERE organization_id = $1`, [req.orgId]),
      db.query(`SELECT count(*)::int AS c FROM units WHERE organization_id = $1`, [req.orgId]),
      db.query(`SELECT count(*)::int AS c FROM tenants WHERE organization_id = $1`, [req.orgId]),
      db.query(`SELECT count(*)::int AS c FROM organization_users WHERE organization_id = $1`, [req.orgId]),
    ]);
    return res.json({
      organizationId: req.orgId,
      branches: branches.rows[0].c,
      properties: properties.rows[0].c,
      buildings: buildings.rows[0].c,
      units: units.rows[0].c,
      tenants: tenants.rows[0].c,
      staff: staff.rows[0].c,
    });
  }

  if (scope.length === 0) {
    return res.json({ organizationId: req.orgId, branches: 0, properties: 0, buildings: 0, units: 0, tenants: 0, staff: 1 });
  }

  // Scoped staff (below org_admin): every number below reflects only the
  // branches/properties they're assigned to, not the whole organization —
  // matches what their Branches/Properties/Units/Tenants tabs actually show.
  const ph = inPlaceholders(scope, 2);
  const { rows: branchRows } = await db.query(
    `SELECT DISTINCT branch_id FROM properties WHERE organization_id = $1 AND id IN (${ph}) AND branch_id IS NOT NULL`,
    [req.orgId, ...scope]
  );
  const branchIdsInScope = branchRows.map(r => r.branch_id);

  const [buildings, units, tenants] = await Promise.all([
    db.query(`SELECT count(*)::int AS c FROM buildings WHERE organization_id = $1 AND property_id IN (${ph})`, [req.orgId, ...scope]),
    db.query(`SELECT count(*)::int AS c FROM units WHERE organization_id = $1 AND property_id IN (${ph})`, [req.orgId, ...scope]),
    db.query(
      `SELECT count(*)::int AS c FROM tenants t JOIN units u ON u.id = t.unit_id
       WHERE t.organization_id = $1 AND u.property_id IN (${ph})`,
      [req.orgId, ...scope]
    ),
  ]);

  let staffCount = 1; // at minimum, the caller themselves
  {
    const conditions = [`sa.property_id IN (${inPlaceholders(scope, 1)})`];
    const params = [...scope];
    if (branchIdsInScope.length) {
      conditions.push(`sa.branch_id IN (${inPlaceholders(branchIdsInScope, params.length + 1)})`);
      params.push(...branchIdsInScope);
    }
    const { rows } = await db.query(
      `SELECT count(DISTINCT organization_user_id)::int AS c FROM staff_assignments sa WHERE ${conditions.join(' OR ')}`,
      params
    );
    staffCount = Math.max(rows[0].c, 1);
  }

  res.json({
    organizationId: req.orgId,
    branches: branchIdsInScope.length,
    properties: scope.length,
    buildings: buildings.rows[0].c,
    units: units.rows[0].c,
    tenants: tenants.rows[0].c,
    staff: staffCount,
  });
});

// ═══════════════════════════════ MAINTENANCE REQUESTS ═══════════════════════════════
// Tenants file these from the portal (routes/tenant.js); staff triage/work
// them here, scoped the same way as tenants/units (via scopedPropertyIds).
const MAINT_LIST_COLS = `mr.id, mr.organization_id, mr.tenant_id, mr.unit_id, mr.property_id, mr.category, mr.priority,
  mr.description, mr.status, mr.staff_notes, mr.created_at, mr.updated_at, mr.resolved_at,
  (mr.photo_data IS NOT NULL) AS has_photo`;

router.get('/maintenance-requests', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);
  const { rows } = scope === null
    ? await db.query(
        `SELECT ${MAINT_LIST_COLS}, t.name AS tenant_name, t.email AS tenant_email, u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN tenants t ON t.id = mr.tenant_id
         LEFT JOIN units u ON u.id = mr.unit_id
         LEFT JOIN properties p ON p.id = mr.property_id
         WHERE mr.organization_id = $1 ORDER BY mr.created_at DESC`,
        [req.orgId]
      )
    : await db.query(
        `SELECT ${MAINT_LIST_COLS}, t.name AS tenant_name, t.email AS tenant_email, u.unit_number, p.name AS property_name
         FROM maintenance_requests mr
         JOIN tenants t ON t.id = mr.tenant_id
         LEFT JOIN units u ON u.id = mr.unit_id
         LEFT JOIN properties p ON p.id = mr.property_id
         WHERE mr.organization_id = $1 AND mr.property_id IN (${inPlaceholders(scope, 2)})
         ORDER BY mr.created_at DESC`,
        [req.orgId, ...scope]
      );
  res.json(rows);
});

router.get('/maintenance-requests/:id/photo', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);
  const { rows } = await db.query(
    `SELECT photo_data, photo_mime, property_id FROM maintenance_requests WHERE id = $1 AND organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!rows.length || !rows[0].photo_data) return res.status(404).json({ error: 'No photo on this request' });
  if (scope !== null && (!rows[0].property_id || !scope.includes(rows[0].property_id))) return res.status(403).json({ error: 'Outside your assigned properties' });
  res.setHeader('Content-Type', rows[0].photo_mime);
  res.send(Buffer.from(rows[0].photo_data, 'base64'));
});

const MAINT_ROLES = ['org_admin', 'branch_manager', 'property_manager', 'maintenance_supervisor', 'maintenance_tech', 'super_admin'];
const MAINT_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

router.patch('/maintenance-requests/:id', requireRole(...MAINT_ROLES), async (req, res) => {
  const { status, priority, staffNotes } = req.body || {};
  if (status && !MAINT_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${MAINT_STATUSES.join(', ')}` });

  const scope = await scopedPropertyIds(req.session.user);
  const { rows: existing } = await db.query(
    `SELECT * FROM maintenance_requests WHERE id = $1 AND organization_id = $2`, [req.params.id, req.orgId]
  );
  if (!existing.length) return res.status(404).json({ error: 'Maintenance request not found' });
  if (scope !== null && (!existing[0].property_id || !scope.includes(existing[0].property_id))) {
    return res.status(403).json({ error: 'Outside your assigned properties' });
  }

  const { rows } = await db.query(
    `UPDATE maintenance_requests SET
       status = COALESCE($1, status),
       priority = COALESCE($2, priority),
       staff_notes = COALESCE($3, staff_notes),
       updated_at = now(),
       resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN now() ELSE resolved_at END
     WHERE id = $4 RETURNING *`,
    [status || null, priority || null, staffNotes != null ? staffNotes : null, req.params.id]
  );
  await logAction(req, 'maintenance.update', 'maintenance_request', req.params.id, { status, priority });
  res.json(rows[0]);
});

// ═══════════════════════════════ DOCUMENTS (digital lease / e-sign) ═══════════════════════════════
// Staff push a document (lease, renewal, notice) to a specific tenant.
// If requiresSignature is set, it shows as pending in the tenant portal
// until the tenant e-signs it (typed name + timestamp + IP — see
// routes/tenant.js POST /documents/:id/sign). This is NOT a DocuSign
// integration; a real legally-binding e-signature vendor is a separate
// paid third-party account the org would need to set up.
const DOC_ROLES = ['org_admin', 'branch_manager', 'property_manager', 'office_staff', 'super_admin'];
const DOC_TYPES = ['lease', 'renewal', 'notice', 'addendum', 'other'];

router.post('/documents', requireRole(...DOC_ROLES), upload.single('file'), async (req, res) => {
  const { tenantId, title, docType, requiresSignature } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'File is required (field name "file")' });
  if (!tenantId || !title) return res.status(400).json({ error: 'tenantId and title are required' });
  if (docType && !DOC_TYPES.includes(docType)) return res.status(400).json({ error: `docType must be one of: ${DOC_TYPES.join(', ')}` });

  const { rows: tenantRows } = await db.query(`SELECT id, unit_id FROM tenants WHERE id = $1 AND organization_id = $2`, [tenantId, req.orgId]);
  if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found in this organization' });

  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null) {
    const { rows: unitRows } = await db.query(`SELECT property_id FROM units WHERE id = $1`, [tenantRows[0].unit_id]);
    if (!unitRows.length || !scope.includes(unitRows[0].property_id)) return res.status(403).json({ error: 'Outside your assigned properties' });
  }

  const needsSig = requiresSignature === true || requiresSignature === 'true';
  const { rows } = await db.query(
    `INSERT INTO documents (organization_id, tenant_id, uploaded_by, title, doc_type, file_name, file_mime, file_data, requires_signature, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, organization_id, tenant_id, uploaded_by, title, doc_type, file_name, file_mime, requires_signature, status, signed_name, signed_at, created_at`,
    [req.orgId, tenantId, req.session.user.id, title, docType || 'other', req.file.originalname, req.file.mimetype,
     req.file.buffer.toString('base64'), needsSig, needsSig ? 'pending_signature' : 'active']
  );
  await logAction(req, 'document.upload', 'document', rows[0].id, { title, tenantId });
  res.json(rows[0]);
});

router.get('/documents', async (req, res) => {
  const { tenantId } = req.query;
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);

  const conditions = ['d.organization_id = $1'];
  const params = [req.orgId];
  if (tenantId) { params.push(tenantId); conditions.push(`d.tenant_id = $${params.length}`); }
  if (scope !== null) { params.push(...scope); conditions.push(`u.property_id IN (${inPlaceholders(scope, params.length - scope.length + 1)})`); }

  const { rows } = await db.query(
    `SELECT d.id, d.organization_id, d.tenant_id, d.title, d.doc_type, d.file_name, d.file_mime,
            d.requires_signature, d.status, d.signed_name, d.signed_at, d.created_at,
            t.name AS tenant_name
     FROM documents d
     JOIN tenants t ON t.id = d.tenant_id
     LEFT JOIN units u ON u.id = t.unit_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY d.created_at DESC`,
    params
  );
  res.json(rows);
});

router.get('/documents/:id/file', async (req, res) => {
  const scope = await scopedPropertyIds(req.session.user);
  const { rows } = await db.query(
    `SELECT d.*, u.property_id FROM documents d
     JOIN tenants t ON t.id = d.tenant_id LEFT JOIN units u ON u.id = t.unit_id
     WHERE d.id = $1 AND d.organization_id = $2`,
    [req.params.id, req.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  if (scope !== null && (!rows[0].property_id || !scope.includes(rows[0].property_id))) return res.status(403).json({ error: 'Outside your assigned properties' });
  res.setHeader('Content-Type', rows[0].file_mime);
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].file_name}"`);
  res.send(Buffer.from(rows[0].file_data, 'base64'));
});

// ═══════════════════════════════ PAYMENTS / RECEIPTS ═══════════════════════════════
// Staff can manually record a payment received off-platform (cash, check,
// money order). Online Stripe payments are tenant-initiated from the
// portal — see routes/tenant.js — and land here with method='stripe' once
// confirmed. Every payment gets a receipt_number the tenant can reference.
router.post('/payments', requireRole(...DOC_ROLES), async (req, res) => {
  const { tenantId, amount, memo, paidAt } = req.body || {};
  if (!tenantId || amount == null) return res.status(400).json({ error: 'tenantId and amount are required' });
  const amountCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  const { rows: tenantRows } = await db.query(`SELECT id, unit_id FROM tenants WHERE id = $1 AND organization_id = $2`, [tenantId, req.orgId]);
  if (!tenantRows.length) return res.status(404).json({ error: 'Tenant not found in this organization' });

  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null) {
    const { rows: unitRows } = await db.query(`SELECT property_id FROM units WHERE id = $1`, [tenantRows[0].unit_id]);
    if (!unitRows.length || !scope.includes(unitRows[0].property_id)) return res.status(403).json({ error: 'Outside your assigned properties' });
  }

  const receiptNumber = 'RCPT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const { rows } = await db.query(
    `INSERT INTO payments (organization_id, tenant_id, unit_id, amount_cents, method, status, receipt_number, memo, recorded_by, paid_at)
     VALUES ($1, $2, $3, $4, 'manual', 'paid', $5, $6, $7, COALESCE($8, now())) RETURNING *`,
    [req.orgId, tenantId, tenantRows[0].unit_id, amountCents, receiptNumber, memo || null, req.session.user.id, paidAt || null]
  );
  await logAction(req, 'payment.record', 'payment', rows[0].id, { amountCents });
  res.json(rows[0]);
});

router.get('/payments', async (req, res) => {
  const { tenantId } = req.query;
  const scope = await scopedPropertyIds(req.session.user);
  if (scope !== null && scope.length === 0) return res.json([]);

  const conditions = ['py.organization_id = $1'];
  const params = [req.orgId];
  if (tenantId) { params.push(tenantId); conditions.push(`py.tenant_id = $${params.length}`); }
  if (scope !== null) { params.push(...scope); conditions.push(`u.property_id IN (${inPlaceholders(scope, params.length - scope.length + 1)})`); }

  const { rows } = await db.query(
    `SELECT py.*, t.name AS tenant_name FROM payments py
     JOIN tenants t ON t.id = py.tenant_id
     LEFT JOIN units u ON u.id = py.unit_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY py.paid_at DESC`,
    params
  );
  res.json(rows);
});

module.exports = router;
