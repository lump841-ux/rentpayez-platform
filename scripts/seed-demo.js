'use strict';
// Seeds a realistic demo organization against a running rentpayez-platform
// instance over its real HTTP API (not direct DB writes) — so it exercises
// exactly the same code paths a real customer would hit, and works
// identically whether BASE_URL points at a local dev server or a deployed
// one. Safe to re-run: signup/tenant-create failures from already-existing
// demo data are caught and reported rather than crashing the whole script.
//
// Usage:
//   node scripts/seed-demo.js                       # BASE_URL defaults to http://localhost:4000
//   BASE_URL=https://your-app.up.railway.app node scripts/seed-demo.js

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

const ADMIN = {
  orgName: 'Meridian Property Group',
  adminName: 'Alex Rivera',
  email: 'demo@rentpayez.com',
  password: 'DemoAdmin2026!',
};

// branch_name,property_name,property_address,building_name,unit_number,monthly_rent
const PORTFOLIO_CSV = `branch_name,property_name,property_address,building_name,unit_number,monthly_rent
North Portfolio,Maple Ridge Apartments,410 Maple Ridge Rd,Building A,101,1450
North Portfolio,Maple Ridge Apartments,410 Maple Ridge Rd,Building A,102,1450
North Portfolio,Maple Ridge Apartments,410 Maple Ridge Rd,Building A,103,1550
North Portfolio,Maple Ridge Apartments,410 Maple Ridge Rd,Building B,201,1600
North Portfolio,Maple Ridge Apartments,410 Maple Ridge Rd,Building B,202,1600
North Portfolio,Sunset Gardens,88 Sunset Blvd,,1,1200
North Portfolio,Sunset Gardens,88 Sunset Blvd,,2,1250
North Portfolio,Sunset Gardens,88 Sunset Blvd,,3,1250
South Portfolio,Harbor View Flats,22 Harbor View Way,Tower 1,501,1900
South Portfolio,Harbor View Flats,22 Harbor View Way,Tower 1,502,1900
South Portfolio,Harbor View Flats,22 Harbor View Way,Tower 1,503,2050
South Portfolio,Harbor View Flats,22 Harbor View Way,Tower 2,601,2100
`;

const TENANTS = [
  { name: 'Jordan Blake', email: 'jordan.blake@example.com', phone: '555-010-1101', unitNumber: '101', dueDay: 1 },
  { name: 'Priya Natarajan', email: 'priya.n@example.com', phone: '555-010-1102', unitNumber: '201', dueDay: 5 },
  { name: 'Marcus Webb', email: 'marcus.webb@example.com', phone: '555-010-1103', unitNumber: '502', dueDay: 15 },
];

function jar() {
  let cookie = '';
  return async function req(method, path, body) {
    const isForm = body instanceof FormData;
    const res = await fetch(BASE_URL + path, {
      method,
      headers: Object.assign(
        isForm ? {} : { 'Content-Type': 'application/json' },
        cookie ? { Cookie: cookie } : {}
      ),
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

async function main() {
  console.log(`Seeding demo data at ${BASE_URL} ...\n`);

  // 1) Health check
  const health = await fetch(BASE_URL + '/health').catch(() => null);
  if (!health || !health.ok) {
    console.error(`Could not reach ${BASE_URL}/health — is the server running?`);
    process.exit(1);
  }

  // 2) Sign up the demo organization (staff/admin session)
  const staff = jar();
  const signup = await staff('POST', '/api/auth/signup-organization', ADMIN);
  if (signup.status === 409) {
    console.log('Demo organization already exists — logging in instead.');
    const login = await staff('POST', '/api/auth/login', { email: ADMIN.email, password: ADMIN.password });
    if (login.status !== 200) { console.error('Could not log in to existing demo org:', login.data); process.exit(1); }
  } else if (signup.status !== 200) {
    console.error('signup-organization failed:', signup.data);
    process.exit(1);
  } else {
    console.log(`Created organization "${ADMIN.orgName}" (admin: ${ADMIN.email})`);
  }

  // 3) Bulk-import the portfolio (branches/properties/buildings/units)
  const previewForm = new FormData();
  previewForm.append('file', new Blob([PORTFOLIO_CSV], { type: 'text/csv' }), 'portfolio.csv');
  const preview = await staff('POST', '/api/import/portfolio/preview', previewForm);
  if (preview.status !== 200) { console.error('portfolio preview failed:', preview.data); process.exit(1); }

  const commitForm = new FormData();
  commitForm.append('file', new Blob([PORTFOLIO_CSV], { type: 'text/csv' }), 'portfolio.csv');
  commitForm.append('mapping', JSON.stringify(preview.data.suggestedMapping));
  const commit = await staff('POST', '/api/import/portfolio/commit', commitForm);
  if (commit.status !== 200) { console.error('portfolio commit failed:', commit.data); process.exit(1); }
  console.log(
    `Imported portfolio: ${commit.data.propertiesCreated} properties, ${commit.data.buildingsCreated} buildings, ` +
    `${commit.data.unitsCreated} units created (${commit.data.unitsSkipped} already existed).`
  );

  // 4) Look up unit IDs by unit_number so we can attach tenants + due days
  const unitsRes = await staff('GET', '/api/units');
  const unitByNumber = new Map(unitsRes.data.map(u => [u.unit_number, u]));

  // 5) Create tenants (captures each real temp password from the API response)
  const tenantCreds = [];
  for (const t of TENANTS) {
    const unit = unitByNumber.get(t.unitNumber);
    const res = await staff('POST', '/api/tenants', { name: t.name, email: t.email, phone: t.phone, unitId: unit ? unit.id : null });
    if (res.status === 409) {
      console.log(`Tenant ${t.email} already exists — skipping creation.`);
      continue;
    }
    if (res.status !== 200) { console.error(`tenant create failed for ${t.email}:`, res.data); continue; }
    tenantCreds.push({ name: t.name, email: t.email, password: res.data.tempPassword, unitNumber: t.unitNumber });
    console.log(`Created tenant ${t.name} <${t.email}> in unit ${t.unitNumber}`);

    if (unit && t.dueDay) {
      await staff('PATCH', `/api/units/${unit.id}`, { rentDueDay: t.dueDay });
    }
  }

  // 6) Record a manual rent payment for the first tenant (Payments tab)
  if (tenantCreds.length) {
    const staffTenants = await staff('GET', '/api/tenants');
    const jordan = staffTenants.data.find(t => t.email === TENANTS[0].email);
    if (jordan) {
      await staff('POST', '/api/payments', { tenantId: jordan.id, amount: 1450, memo: 'March rent — check #1042' });
      console.log('Recorded a manual rent payment for Jordan Blake.');
    }
  }

  // 7) Log in as the "hero" tenant (Jordan Blake) and file a maintenance request,
  //    so both the admin console and tenant portal have live activity to show.
  const heroCreds = tenantCreds.find(t => t.email === TENANTS[0].email);
  if (heroCreds) {
    const tenantSession = jar();
    const tLogin = await tenantSession('POST', '/api/tenant-auth/login', { email: heroCreds.email, password: heroCreds.password });
    if (tLogin.status === 200) {
      await tenantSession('POST', '/api/tenant/maintenance-requests', {
        category: 'plumbing',
        priority: 'normal',
        description: 'Kitchen faucet has a slow drip — not urgent but would love it looked at.',
      });
      console.log('Filed a maintenance request as Jordan Blake (tenant portal).');
    }
  }

  // 8) Staff conducts a quick move-in inspection on unit 101
  const unit101 = unitByNumber.get('101');
  if (unit101) {
    await staff('POST', '/api/inspections', {
      unitId: unit101.id,
      inspectionType: 'move_in',
      overallNotes: 'Standard move-in walkthrough, unit in good condition overall.',
      items: [
        { room: 'Kitchen', condition: 'good', notes: 'Appliances clean, no damage noted.' },
        { room: 'Living Room', condition: 'good', notes: 'Fresh paint, carpets clean.' },
        { room: 'Bathroom', condition: 'fair', notes: 'Minor grout wear near tub.' },
      ],
    });
    console.log('Logged a move-in inspection for unit 101.');
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n================ DEMO IS READY ================');
  console.log(`Admin console:  ${BASE_URL}/admin/login.html`);
  console.log(`  email:    ${ADMIN.email}`);
  console.log(`  password: ${ADMIN.password}`);
  console.log(`\nTenant portal:  ${BASE_URL}/tenant/login.html`);
  for (const t of tenantCreds) {
    console.log(`  ${t.name} (unit ${t.unitNumber}) — ${t.email} / ${t.password}`);
  }
  if (!tenantCreds.length) {
    console.log('  (no new tenants created this run — organization already had them; check the admin console\'s Tenants tab.)');
  }
  console.log('=================================================\n');
}

main().catch(err => { console.error('Seed script failed:', err); process.exit(1); });
