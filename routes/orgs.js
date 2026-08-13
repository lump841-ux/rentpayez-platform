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
router.post('/tenants', requireRole('org_admin', 'branch_manager', 'property_manager', 'office_staff', 'super_admin'), async (req, res) => {
  const { name, email, phone, unitId } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });
  try {
    const { rows } = await db.query(
      `INSERT INTO tenants (organization_id, unit_id, name, email, phone, status)
       VALUES ($1, $2, $3, $4, $5, 'invited') RETURNING *`,
      [req.orgId, unitId || null, name, email.toLowerCase().trim(), phone || null]
    );
    await logAction(req, 'tenant.create', 'tenant', rows[0].id, { name, email });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A tenant with that email already exists in this organization.' });
    throw err;
  }
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

  const results = { created: 0, skipped: [], errors: [] };
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
      await db.query(
        `INSERT INTO tenants (organization_id, unit_id, name, email, phone, status)
         VALUES ($1, $2, $3, $4, $5, 'invited')`,
        [req.orgId, unitId, name, email, row.phone ? row.phone.trim() : null]
      );
      results.created++;
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
  const [branches, properties, buildings, units, tenants, staff] = await Promise.all([
    db.query(`SELECT count(*)::int AS c FROM branches WHERE organization_id = $1`, [req.orgId]),
    db.query(`SELECT count(*)::int AS c FROM properties WHERE organization_id = $1`, [req.orgId]),
    db.query(`SELECT count(*)::int AS c FROM buildings WHERE organization_id = $1`, [req.orgId]),
    db.query(`SELECT count(*)::int AS c FROM units WHERE organization_id = $1`, [req.orgId]),
    db.query(`SELECT count(*)::int AS c FROM tenants WHERE organization_id = $1`, [req.orgId]),
    db.query(`SELECT count(*)::int AS c FROM organization_users WHERE organization_id = $1`, [req.orgId]),
  ]);
  res.json({
    organizationId: req.orgId,
    branches: branches.rows[0].c,
    properties: properties.rows[0].c,
    buildings: buildings.rows[0].c,
    units: units.rows[0].c,
    tenants: tenants.rows[0].c,
    staff: staff.rows[0].c,
  });
});

module.exports = router;
