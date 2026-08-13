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

  const priyaUnits = await priya('GET', '/api/units');
  const priyaUnitIds = (Array.isArray(priyaUnits.data) ? priyaUnits.data : []).map(u => u.id);
  ok(
    priyaUnits.status === 200 &&
    priyaUnitIds.includes(unit.data.id) &&
    !priyaUnitIds.includes(unit2.data.id),
    'Branch manager sees ONLY units under their assigned branch\'s property, not the branch-less property\'s unit'
  );

  const priyaBranches = await priya('GET', '/api/branches');
  const priyaBranchIds = (Array.isArray(priyaBranches.data) ? priyaBranches.data : []).map(b => b.id);
  ok(
    priyaBranches.status === 200 && priyaBranchIds.length === 1 && priyaBranchIds.includes(branch.data.id),
    'Branch manager\'s branch list is scoped too — sees only their own branch, not a full org-wide list'
  );

  const priyaOtherUnitsAttempt = await priya('GET', `/api/units?propertyId=${property2.data.id}`);
  ok(
    Array.isArray(priyaOtherUnitsAttempt.data) && priyaOtherUnitsAttempt.data.length === 0,
    'Branch manager cannot pull units for a property outside their scope by passing its propertyId directly'
  );

  const priyaSummary = await priya('GET', '/api/summary');
  ok(
    priyaSummary.status === 200 &&
    priyaSummary.data.branches === 1 && priyaSummary.data.properties === 1 && priyaSummary.data.units === 1,
    `Branch manager's Overview stats are scoped too — 1 branch, 1 property, 1 unit, not the whole org (got ${JSON.stringify(priyaSummary.data)})`
  );

  console.log('\n── Org A: tenants (individual + CSV import) ──');
  const tenant = await orgA('POST', '/api/tenants', { name: 'Sara Kim', email: 'sara.kim@email.com', unitId: unit.data.id });
  ok(tenant.status === 200 && tenant.data.unit_id === unit.data.id, 'Org A adds a tenant assigned directly to a unit');
  ok(!!tenant.data.tempPassword, 'Adding a tenant returns a Resident Portal temp password');
  ok(tenant.data.password_hash === undefined, 'The password hash itself is never sent back to the client');

  console.log('\n── Resident Portal: tenant login is a separate identity from staff ──');
  const residentSession = makeSession(base);
  const badLogin = await residentSession('POST', '/api/tenant-auth/login', { email: 'sara.kim@email.com', password: 'wrong-password' });
  ok(badLogin.status === 401, 'Tenant portal rejects a wrong password');

  const residentLogin = await residentSession('POST', '/api/tenant-auth/login', { email: 'sara.kim@email.com', password: tenant.data.tempPassword });
  ok(residentLogin.status === 200 && residentLogin.data.tenant.email === 'sara.kim@email.com', 'Tenant logs in with the temp password');

  const staffRouteAsTenant = await residentSession('GET', '/api/tenants');
  ok(staffRouteAsTenant.status === 401, 'A logged-in tenant session cannot hit staff-only routes (separate identity, not just a lower role)');

  const myUnit = await residentSession('GET', '/api/tenant/me');
  ok(
    myUnit.status === 200 && myUnit.data.unit_number === unit.data.unit_number && myUnit.data.property_name === property.data.name,
    `Tenant sees their own unit and property (got ${JSON.stringify(myUnit.data)})`
  );

  const updatePhone = await residentSession('PATCH', '/api/tenant/me', { phone: '555-9999' });
  ok(updatePhone.status === 200 && updatePhone.data.phone === '555-9999', 'Tenant can update their own phone number');

  console.log('\n── Resident Portal: logging in as a tenant in a browser that was staff (or vice versa) fully switches identity ──');
  // Regression test for a real bug caught against production: a session
  // that had already logged in as staff, then logged in as a tenant
  // WITHOUT the cookie changing, kept BOTH identities — the tenant portal
  // worked, but staff-only routes stayed reachable underneath because
  // req.session.user was never cleared. Reuse orgA's own already-staff
  // session to prove that logging in as a tenant now wipes the staff
  // identity, and logging back in as staff wipes the tenant identity.
  const orgAStaffStillWorksBeforeSwitch = await orgA('GET', '/api/summary');
  ok(orgAStaffStillWorksBeforeSwitch.status === 200, 'Sanity check: orgA session is still staff-authenticated going into the switch test');

  // Give Sara a password we actually know for this test, then log the
  // ALREADY-STAFF orgA session into the tenant portal.
  const saraReset = await orgA('POST', `/api/tenants/${tenant.data.id}/reset-password`);
  const switchToTenant = await orgA('POST', '/api/tenant-auth/login', { email: 'sara.kim@email.com', password: saraReset.data.tempPassword });
  ok(switchToTenant.status === 200, 'A previously-staff session can log into the tenant portal');

  const staffRouteAfterSwitch = await orgA('GET', '/api/summary');
  ok(staffRouteAfterSwitch.status === 401, 'After switching to the tenant identity in the same session, staff routes are now blocked — the old staff identity did not linger');

  const tenantRouteAfterSwitch = await orgA('GET', '/api/tenant/me');
  ok(tenantRouteAfterSwitch.status === 200, 'The same session now correctly acts as the tenant');

  // Switch back to staff and confirm the tenant identity is gone too.
  const switchBackToStaff = await orgA('POST', '/api/auth/login', { email: 'alice@county.gov', password: 'supersecret1' });
  ok(switchBackToStaff.status === 200, 'Logging back in as staff works from the same session');
  const tenantRouteAfterSwitchBack = await orgA('GET', '/api/tenant/me');
  ok(tenantRouteAfterSwitchBack.status === 401, 'Switching back to staff clears the tenant identity — no leftover tenant access either');

  const reactivated = await orgA('GET', '/api/tenants');
  const saraRecord = reactivated.data.find(t => t.email === 'sara.kim@email.com');
  ok(saraRecord && saraRecord.status === 'active', 'Tenant account auto-activates on first successful portal login, same as staff invites');

  const resetRes = await orgA('POST', `/api/tenants/${tenant.data.id}/reset-password`);
  ok(resetRes.status === 200 && !!resetRes.data.tempPassword, 'Org A can reset a tenant\'s portal password and gets a new temp password back');

  const oldPasswordSession = makeSession(base);
  const oldPasswordAttempt = await oldPasswordSession('POST', '/api/tenant-auth/login', { email: 'sara.kim@email.com', password: tenant.data.tempPassword });
  ok(oldPasswordAttempt.status === 401, 'The old temp password stops working immediately after a reset');

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

  console.log('\n── Org A: bulk portfolio import (flexible column mapping) ──');
  // Headers deliberately use alias wording, not the exact field keys, to
  // prove the fuzzy column-matching actually works against an unknown
  // source spreadsheet's own header names.
  const portfolioCsv =
    'Branch,Property,Property Address,Building,Unit,Rent\n' +
    'Sunset Division,Sunset Gardens,55 Sunset Blvd,Tower 1,301,1300\n' +
    'Sunset Division,Sunset Gardens,55 Sunset Blvd,Tower 1,302,1300\n' +
    ',Riverside House,9 River Rd,,5,950\n';
  const pBoundary = '----smoketestportfolioboundary';
  const previewBody =
    `--${pBoundary}\r\nContent-Disposition: form-data; name="file"; filename="portfolio.csv"\r\nContent-Type: text/csv\r\n\r\n${portfolioCsv}\r\n--${pBoundary}--\r\n`;
  const previewRes = await fetch(base + '/api/import/portfolio/preview', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${pBoundary}`, Cookie: await sessionCookie(orgA, base) },
    body: previewBody,
  });
  const previewData = await previewRes.json();
  ok(previewRes.status === 200 && previewData.totalRows === 3, 'Portfolio preview parses the file and counts 3 rows');
  ok(
    previewData.suggestedMapping.branch_name === 'Branch' &&
    previewData.suggestedMapping.property_name === 'Property' &&
    previewData.suggestedMapping.property_address === 'Property Address' &&
    previewData.suggestedMapping.building_name === 'Building' &&
    previewData.suggestedMapping.unit_number === 'Unit' &&
    previewData.suggestedMapping.monthly_rent === 'Rent',
    `Portfolio preview auto-maps aliased headers correctly (got ${JSON.stringify(previewData.suggestedMapping)})`
  );

  function portfolioCommitBody(mapping) {
    return `--${pBoundary}\r\nContent-Disposition: form-data; name="file"; filename="portfolio.csv"\r\nContent-Type: text/csv\r\n\r\n${portfolioCsv}\r\n` +
      `--${pBoundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify(mapping)}\r\n` +
      `--${pBoundary}--\r\n`;
  }

  const commit1 = await fetch(base + '/api/import/portfolio/commit', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${pBoundary}`, Cookie: await sessionCookie(orgA, base) },
    body: portfolioCommitBody(previewData.suggestedMapping),
  });
  const commit1Data = await commit1.json();
  ok(
    commit1.status === 200 && commit1Data.branchesCreated === 1 && commit1Data.propertiesCreated === 2 &&
    commit1Data.buildingsCreated === 1 && commit1Data.unitsCreated === 3 && commit1Data.unitsSkipped === 0,
    `First portfolio import creates 1 branch, 2 properties, 1 building, 3 units (got ${JSON.stringify(commit1Data)})`
  );

  const commit2 = await fetch(base + '/api/import/portfolio/commit', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${pBoundary}`, Cookie: await sessionCookie(orgA, base) },
    body: portfolioCommitBody(previewData.suggestedMapping),
  });
  const commit2Data = await commit2.json();
  ok(
    commit2.status === 200 && commit2Data.branchesCreated === 0 && commit2Data.propertiesCreated === 0 &&
    commit2Data.buildingsCreated === 0 && commit2Data.unitsCreated === 0 && commit2Data.unitsSkipped === 3,
    `Re-uploading the same file finds everything already exists and skips all 3 units instead of duplicating (got ${JSON.stringify(commit2Data)})`
  );

  console.log('\n── Schema statement-splitting regression (the exact production bug) ──');
  // Regression test for a real bug caught in production: initDB() re-runs
  // schema.sql on every server boot. The staff_assignments ADD CONSTRAINT
  // statements have no idempotent form in Postgres, so they genuinely
  // fail with 42710 (duplicate_object) on every boot after the very
  // first. The OLD code ran the whole file as ONE multi-statement
  // pool.query(), which stops dead at the first failing statement — so
  // anything positioned after those ALTER TABLEs (which at the time
  // included the entire maintenance_requests/documents/payments tables)
  // silently never got (re-)created on any boot past the first, even
  // though every CREATE TABLE was written as idempotent IF NOT EXISTS.
  // Fixed by running each statement individually (services/db.js
  // applySchema()) so one expected failure can't block the rest.
  //
  // Tested here against a synthetic script — independent of the real
  // schema.sql's current statement order — using a table name ('a') that
  // is guaranteed to already exist by the time this runs, so the ALTER
  // TABLE genuinely throws 42710 for real, not a mock:
  const db = require(path.join(__dirname, '..', 'services', 'db.js'));
  const probeId = Date.now().toString(36);
  const parent = 'regression_parent_' + probeId;
  const child  = 'regression_child_' + probeId;
  // Mirrors the real schema.sql shape exactly: a FOREIGN KEY constraint
  // (not a CHECK) added via ALTER TABLE — this is what staff_assignments'
  // fk_staff_branch/fk_staff_property actually are, and real Postgres
  // reports 42710 for a duplicate FK constraint name the same way.
  await db.applySchema(`
    CREATE TABLE IF NOT EXISTS ${parent} (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE IF NOT EXISTS ${child} (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), parent_id UUID);
    ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (parent_id) REFERENCES ${parent}(id);
  `);
  // Second pass: the ADD CONSTRAINT above will now genuinely fail with
  // "already exists" (42710) — exactly the real restart scenario. A
  // CREATE TABLE placed AFTER it must still run despite that failure.
  const afterTable = 'regression_after_' + probeId;
  await db.applySchema(`
    ALTER TABLE ${child} ADD CONSTRAINT ${child}_fk FOREIGN KEY (parent_id) REFERENCES ${parent}(id);
    CREATE TABLE IF NOT EXISTS ${afterTable} (id INT);
  `);
  const probeCheck = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name = $1`, [afterTable]
  ).catch(() => ({ rows: [] }));
  ok(probeCheck.rows.length === 1, 'A CREATE TABLE positioned right after a genuinely-failing (42710) ALTER TABLE still runs — this is exactly the bug that silently dropped maintenance_requests/documents/payments in production');

  console.log('\n── Maintenance requests ──');
  const mrCreate = await residentSession('POST', '/api/tenant/maintenance-requests', { category: 'plumbing', priority: 'high', description: 'Kitchen sink leaking' });
  ok(mrCreate.status === 200 && mrCreate.data.status === 'open', 'Tenant files a maintenance request');

  const mrOwnList = await residentSession('GET', '/api/tenant/maintenance-requests');
  ok(mrOwnList.status === 200 && mrOwnList.data.some(r => r.id === mrCreate.data.id), 'Tenant sees their own maintenance request');

  const mrStaffList = await orgA('GET', '/api/maintenance-requests');
  const mrStaffRow = mrStaffList.data.find(r => r.id === mrCreate.data.id);
  ok(mrStaffList.status === 200 && mrStaffRow && mrStaffRow.tenant_name === 'Sara Kim', 'Staff sees the maintenance request with the tenant\'s name joined in');

  const mrPriyaList = await priya('GET', '/api/maintenance-requests');
  ok(mrPriyaList.data.some(r => r.id === mrCreate.data.id), 'Branch manager sees the request — it\'s under a property in their scope');

  const mrUpdate = await orgA('PATCH', `/api/maintenance-requests/${mrCreate.data.id}`, { status: 'resolved', staffNotes: 'Replaced the trap, fixed.' });
  ok(mrUpdate.status === 200 && mrUpdate.data.status === 'resolved' && mrUpdate.data.resolved_at, 'Staff resolves the request and resolved_at gets stamped');

  console.log('\n── Maintenance request photo proof ──');
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const mrWithPhoto = await residentSession('POST', '/api/tenant/maintenance-requests', {
    category: 'electrical', priority: 'medium', description: 'Outlet sparking', photoBase64: tinyPngBase64, photoMime: 'image/png',
  });
  ok(mrWithPhoto.status === 200 && mrWithPhoto.data.has_photo === true, 'Tenant files a maintenance request with a photo, response flags has_photo instead of embedding the blob');

  const mrListHasPhotoFlag = await residentSession('GET', '/api/tenant/maintenance-requests');
  const mrPhotoRow = mrListHasPhotoFlag.data.find(r => r.id === mrWithPhoto.data.id);
  ok(mrPhotoRow && mrPhotoRow.has_photo === true && !mrPhotoRow.photo_data, 'List view shows has_photo flag but never the raw photo blob');

  const mrPhotoFetch = await residentSession('GET', `/api/tenant/maintenance-requests/${mrWithPhoto.data.id}/photo`);
  ok(mrPhotoFetch.status === 200, 'Tenant can fetch their own maintenance photo back');

  const mrPhotoStaffFetch = await orgA('GET', `/api/maintenance-requests/${mrWithPhoto.data.id}/photo`);
  ok(mrPhotoStaffFetch.status === 200, 'Staff can fetch the tenant-submitted photo');

  const mrPhotoNoneFetch = await residentSession('GET', `/api/tenant/maintenance-requests/${mrCreate.data.id}/photo`);
  ok(mrPhotoNoneFetch.status === 404, 'Fetching a photo for a request that has none returns 404, not a crash');

  console.log('\n── My Goals ──');
  const goalCreate = await residentSession('POST', '/api/tenant/goals', { title: 'Save for a car', targetNote: '$5,000 by December' });
  ok(goalCreate.status === 200 && goalCreate.data.progress_pct === 0 && goalCreate.data.status === 'in_progress', 'Tenant creates a goal, starts at 0% in_progress');

  const goalList = await residentSession('GET', '/api/tenant/goals');
  ok(goalList.status === 200 && goalList.data.some(g => g.id === goalCreate.data.id), 'Tenant sees their goal in the list');

  const goalUpdate = await residentSession('PATCH', `/api/tenant/goals/${goalCreate.data.id}`, { progressPct: 60 });
  ok(goalUpdate.status === 200 && goalUpdate.data.progress_pct === 60, 'Tenant updates goal progress');

  const goalComplete = await residentSession('PATCH', `/api/tenant/goals/${goalCreate.data.id}`, { progressPct: 100, status: 'done' });
  ok(goalComplete.status === 200 && goalComplete.data.status === 'done', 'Tenant marks a goal done');

  const goalDelete = await residentSession('DELETE', `/api/tenant/goals/${goalCreate.data.id}`);
  ok(goalDelete.status === 200, 'Tenant deletes a goal');

  const goalListAfterDelete = await residentSession('GET', '/api/tenant/goals');
  ok(!goalListAfterDelete.data.some(g => g.id === goalCreate.data.id), 'Deleted goal no longer appears in the list');

  console.log('\n── AI Coach ──');
  // No ANTHROPIC_API_KEY or OPENAI_API_KEY is set in this test environment
  // (real credentials the org adds themselves in Render, same pattern as
  // Stripe) — so the coach must degrade to a clear 503, never crash or
  // silently fabricate a reply (especially never a fake credit score).
  const coachNoKey = await residentSession('POST', '/api/tenant/coach/message', { message: 'What is my credit score?' });
  ok(coachNoKey.status === 503, 'Coach returns a clear "not set up yet" error when no LLM API key is configured, instead of crashing or fabricating an answer');

  const coachEmptyMessage = await residentSession('POST', '/api/tenant/coach/message', { message: '' });
  ok(coachEmptyMessage.status === 400 || coachEmptyMessage.status === 503, 'Coach rejects an empty message (400) or still reports unconfigured (503) — never a 500');

  console.log('\n── Documents (digital lease / e-signature) ──');
  const leaseBoundary = '----smoketestleaseboundary';
  const leaseBytes = 'PDF-ish lease content for testing';
  const leaseUploadBody =
    `--${leaseBoundary}\r\nContent-Disposition: form-data; name="tenantId"\r\n\r\n${tenant.data.id}\r\n` +
    `--${leaseBoundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n2026 Lease Renewal\r\n` +
    `--${leaseBoundary}\r\nContent-Disposition: form-data; name="docType"\r\n\r\nrenewal\r\n` +
    `--${leaseBoundary}\r\nContent-Disposition: form-data; name="requiresSignature"\r\n\r\ntrue\r\n` +
    `--${leaseBoundary}\r\nContent-Disposition: form-data; name="file"; filename="lease.pdf"\r\nContent-Type: application/pdf\r\n\r\n${leaseBytes}\r\n` +
    `--${leaseBoundary}--\r\n`;
  const leaseUpload = await fetch(base + '/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${leaseBoundary}`, Cookie: await sessionCookie(orgA, base) },
    body: leaseUploadBody,
  });
  const leaseUploadData = await leaseUpload.json();
  ok(leaseUpload.status === 200 && leaseUploadData.status === 'pending_signature', 'Staff sends a lease renewal to a tenant, marked pending signature');

  const docTenantList = await residentSession('GET', '/api/tenant/documents');
  ok(docTenantList.status === 200 && docTenantList.data.some(d => d.id === leaseUploadData.id && d.status === 'pending_signature'), 'Tenant sees the document waiting on their signature');

  const docDownload = await residentSession('GET', `/api/tenant/documents/${leaseUploadData.id}/file`);
  ok(docDownload.status === 200, 'Tenant can download the document file');

  const docSign = await residentSession('POST', `/api/tenant/documents/${leaseUploadData.id}/sign`, { signedName: 'Sara Kim' });
  ok(docSign.status === 200 && docSign.data.status === 'signed' && docSign.data.signed_name === 'Sara Kim', 'Tenant e-signs the document (typed name + timestamp audit trail)');

  const docSignAgain = await residentSession('POST', `/api/tenant/documents/${leaseUploadData.id}/sign`, { signedName: 'Sara Kim' });
  ok(docSignAgain.status === 400, 'Signing an already-signed document is rejected');

  const docStaffFile = await fetch(base + `/api/documents/${leaseUploadData.id}/file`, { headers: { Cookie: await sessionCookie(orgA, base) } });
  ok(docStaffFile.status === 200, 'Staff can also download the signed document on their end');

  console.log('\n── Payments & receipts (manual + Stripe) ──');
  const payRecord = await orgA('POST', '/api/payments', { tenantId: tenant.data.id, amount: 1450, memo: 'August rent, check #1042' });
  ok(payRecord.status === 200 && payRecord.data.amount_cents === 145000 && payRecord.data.method === 'manual' && payRecord.data.receipt_number, 'Staff manually records a rent payment and gets a receipt number');

  const payStaffList = await orgA('GET', '/api/payments');
  ok(payStaffList.data.some(p => p.id === payRecord.data.id), 'Staff sees the recorded payment');

  const payTenantList = await residentSession('GET', '/api/tenant/payments');
  ok(payTenantList.status === 200 && payTenantList.data.some(p => p.id === payRecord.data.id), 'Tenant sees the payment on their own receipts list');

  // No STRIPE_SECRET_KEY is set in this test environment (and shouldn't
  // be — that's a real credential the org adds themselves in Render), so
  // online checkout must degrade to a clear error, not crash.
  const checkoutNoStripe = await residentSession('POST', '/api/tenant/payments/checkout', {});
  ok(checkoutNoStripe.status === 503, 'Stripe checkout returns a clear "not set up yet" error when STRIPE_SECRET_KEY is unset, instead of crashing');

  const confirmNoStripe = await residentSession('GET', '/api/tenant/payments/confirm?session_id=fake');
  ok(confirmNoStripe.status === 503, 'Stripe confirm also degrades cleanly when unconfigured');

  console.log('\n── Cross-organization isolation (the critical check) ──');
  const bBranches = await orgB('GET', '/api/branches');
  const bProperties = await orgB('GET', '/api/properties');
  const bTenants = await orgB('GET', '/api/tenants');
  const bMaintenance = await orgB('GET', '/api/maintenance-requests');
  const bDocuments = await orgB('GET', '/api/documents');
  const bPayments = await orgB('GET', '/api/payments');
  ok(bBranches.data.length === 0, 'Org B sees ZERO branches (Org A\'s branch is invisible)');
  ok(bProperties.data.length === 0, 'Org B sees ZERO properties (Org A\'s properties are invisible)');
  ok(bTenants.data.length === 0, 'Org B sees ZERO tenants (Org A\'s tenants, including the CSV-imported ones, are invisible)');
  ok(bMaintenance.data.length === 0, 'Org B sees ZERO maintenance requests (Org A\'s are invisible)');
  ok(bDocuments.data.length === 0, 'Org B sees ZERO documents (Org A\'s are invisible)');
  ok(bPayments.data.length === 0, 'Org B sees ZERO payments (Org A\'s are invisible)');
  ok((await orgB('GET', `/api/documents/${leaseUploadData.id}/file`)).status === 404, 'Org B cannot fetch Org A\'s document file by ID either');

  const summaryA = await orgA('GET', '/api/summary');
  ok(summaryA.data.branches === 2 && summaryA.data.properties === 4 && summaryA.data.units === 5 && summaryA.data.tenants === 3,
    `Org A summary is correct: 2 branches, 4 properties, 5 units, 3 tenants (got ${JSON.stringify(summaryA.data)})`);

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
