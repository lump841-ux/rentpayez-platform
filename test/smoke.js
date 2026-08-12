'use strict';
// Phase 1 smoke test — boots the real Express app against an in-memory
// Postgres (pg-mem) and exercises the actual HTTP API end-to-end:
// signup, login, hierarchy CRUD, staff invite + scoping, tenant CSV
// import, and — most importantly — organization data isolation and
// role-based permission enforcement.
//
// This does NOT replace testing against a real Postgres instance before
// going live (pg-mem doesn't implement 100% of Postgres), but it proves
// the schema is valid SQL and the application logic is correct.

process.env.PG_TEST_ADAPTER = require('path').join(__dirname, 'pgmem-adapter.js');
process.env.SESSION_SECRET = 'test-secret';
process.env.PORT = '4001';

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAILED: ${label}`); }
}

// ── Tiny cookie-jar session helper ──────────────────────────────────
function makeSession(base) {
  let cookie = '';
  return async function req(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        cookie ? { Cookie: cookie } : {}
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

async function main() {
  const { start } = require(path.join(__dirname, '..', 'server.js'));
  await start();
  const base = `http://localhost:${process.env.PORT}`;

  console.log('\n── Auth & organization signup ──');
  const orgA = makeSession(base);
  const orgB = makeSession(base);

  const suA = await orgA('POST', '/api/auth/signup-organization', {
    orgName: 'County Housing Authority', adminName: 'Alice Admin', email: 'alice@county.gov', password: 'supersecret1',
  });
  ok(suA.status === 200 && suA.data.organization && suA.data.organization.name === 'County Housing Authority', 'Org A signs up and gets a session');
  const orgAId = suA.data.organization.id;

  const suB = await orgB('POST', '/api/auth/signup-organization', {
    orgName: 'Maple Street Rentals', adminName: 'Bob Landlord', email: 'bob@maplestreet.com', password: 'supersecret2',
  });
  ok(suB.status === 200 && suB.data.organization.name === 'Maple Street Rentals', 'Org B signs up and gets a session');

  const dupe = await orgA('POST', '/api/auth/signup-organization', {
    orgName: 'Another Org', adminName: 'X', email: 'alice@county.gov', password: 'supersecret1',
  });
  ok(dupe.status === 409, 'Duplicate email is rejected on signup');

  const noAuth = await fetch(base + '/api/summary');
  ok(noAuth.status === 401, 'Unauthenticated request to a protected route is rejected (401)');

  console.log('\n── Org A: build hierarchy ──');
  const branch = await orgA('POST', '/api/branches', { name: 'Vine West Division' });
  ok(branch.status === 200 && branch.data.name === 'Vine West Division', 'Org A creates a branch');

  const property = await orgA('POST', '/api/properties', { name: 'Vine West Development', address: '10 Vine St', branchId: branch.data.id });
  ok(property.status === 200, 'Org A creates a property under the branch');

  const property2 = await orgA('POST', '/api/properties', { name: 'Standalone Property (no branch)' });
  ok(property2.status === 200 && property2.data.branch_id === null, 'Org A creates a second, branch-less property (optional levels work)');

  const building = await orgA('POST', '/api/buildings', { name: 'Building A', propertyId: property.data.id });
  ok(building.status === 200, 'Org A creates a building');

  const unit = await orgA('POST', '/api/units', { unitNumber: '101', propertyId: property.data.id, buildingId: building.data.id, monthlyRent: 1450 });
  ok(unit.status === 200 && unit.data.unit_number === '101', 'Org A creates a unit');

  const unit2 = await orgA('POST', '/api/units', { unitNumber: '204', propertyId: property2.data.id });
  ok(unit2.status === 200, 'Org A creates a unit on the branch-less property');

  console.log('\n── Org A: staff invite + role-scoped access ──');
  const invite = await orgA('POST', '/api/staff/invite', { name: 'Priya Manager', email: 'priya@county.gov', role: 'branch_manager' });
  ok(invite.status === 200 && invite.data.tempPassword, 'Org A invites a branch_manager and gets a temp password back (no email service yet)');

  const assign = await orgA('POST', `/api/staff/${invite.data.staff.id}/assign`, { branchId: branch.data.id });
  ok(assign.status === 200, 'Org A assigns the branch_manager to Vine West Division');

  const priya = makeSession(base);
  const priyaLogin = await priya('POST', '/api/auth/login', { email: 'priya@county.gov', password: invite.data.tempPassword });
  ok(priyaLogin.status === 200, 'Branch manager logs in with the temp password');

  const priyaBranchAttempt = await priya('POST', '/api/branches', { name: 'Unauthorized branch' });
  ok(priyaBranchAttempt.status === 403, 'Branch manager is FORBIDDEN from creating a branch (role enforced server-side, not just hidden in UI)');

  const priyaProperties = await priya('GET', '/api/properties');
  const priyaPropIds = (Array.isArray(priyaProperties.data) ? priyaProperties.data : []).map(p => p.id);
  ok(
    priyaProperties.status === 200 &&
    priyaPropIds.includes(property.data.id) &&
    !priyaPropIds.includes(property2.data.id),
    'Branch manager sees ONLY the property under their assigned branch, not the branch-less one'
  );

  console.log('\n── Org A: tenants (individual + CSV import) ──');
  const tenant = await orgA('POST', '/api/tenants', { name: 'Sara Kim', email: 'sara.kim@email.com', unitId: unit.data.id });
  ok(tenant.status === 200 && tenant.data.unit_id === unit.data.id, 'Org A adds a tenant assigned directly to a unit');

  // CSV import via multipart/form-data (built manually — no extra deps needed)
  const csvBody = 'name,email,phone,unit_number\nJames Davis,james.davis@email.com,555-0101,204\nGhost Tenant,ghost@email.com,555-0102,999\n';
  const boundary = '----smoketestboundary';
  const multipart =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tenants.csv"\r\nContent-Type: text/csv\r\n\r\n${csvBody}\r\n--${boundary}--\r\n`;
  const importRes = await fetch(base + '/api/tenants/import-csv', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipart,
  });
  const importData = await importRes.json();
  ok(importRes.status === 401, 'CSV import without auth is rejected — but let\'s also check it works WITH auth below');

  // Redo with Org A's session cookie captured via the helper (need raw fetch since
  // multipart isn't JSON — reuse the cookie the session helper is tracking).
  const importAuthed = await fetch(base + '/api/tenants/import-csv', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Cookie: await sessionCookie(orgA, base) },
    body: multipart,
  });
  const importAuthedData = await importAuthed.json();
  ok(importAuthed.status === 200 && importAuthedData.created === 2, 'CSV import creates 2 tenants');
  ok(importAuthedData.skipped.length === 1 && /999/.test(importAuthedData.skipped[0].reason), 'CSV import reports the unmatched unit_number (999) as skipped, not silently dropped');

  console.log('\n── Cross-organization isolation (the critical check) ──');
  const bBranches = await orgB('GET', '/api/branches');
  const bProperties = await orgB('GET', '/api/properties');
  const bTenants = await orgB('GET', '/api/tenants');
  ok(bBranches.data.length === 0, 'Org B sees ZERO branches (Org A\'s branch is invisible)');
  ok(bProperties.data.length === 0, 'Org B sees ZERO properties (Org A\'s properties are invisible)');
  ok(bTenants.data.length === 0, 'Org B sees ZERO tenants (Org A\'s tenants, including the CSV-imported ones, are invisible)');

  const summaryA = await orgA('GET', '/api/summary');
  ok(summaryA.data.branches === 1 && summaryA.data.properties === 2 && summaryA.data.units === 2 && summaryA.data.tenants === 3,
    `Org A summary is correct: 1 branch, 2 properties, 2 units, 3 tenants (got ${JSON.stringify(summaryA.data)})`);

  console.log(`\n${pass} passed, ${fail} failed.\n`);
  process.exit(fail ? 1 : 0);
}

// Small helper to read the org A cookie the session function is holding —
// re-derives it by making a lightweight authenticated GET and inspecting
// what cookie the browser-equivalent would have sent. Simpler: just log in
// again quickly to grab a fresh cookie for the raw-fetch multipart request.
async function sessionCookie(sessionFn, base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@county.gov', password: 'supersecret1' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

main().catch(err => { console.error('Smoke test crashed:', err); process.exit(1); });
