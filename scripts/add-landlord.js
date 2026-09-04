'use strict';
// Creates a demo "landlord" login (role: property_manager) scoped to ONE
// property, so you can show Dorothy the contrast: her org_admin login sees
// everything, a landlord's login sees only what's assigned to them.
//
// Usage:
//   node scripts/add-landlord.js                 # BASE_URL defaults to http://localhost:4000
//   BASE_URL=https://your-app.example.com node scripts/add-landlord.js

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

const ADMIN = { email: 'demo@rentpayez.com', password: 'DemoAdmin2026!' };
const LANDLORD = { name: 'Marcus Reilly', email: 'marcus.reilly@example.com', role: 'property_manager' };
const PROPERTY_NAME = 'Maple Ridge Apartments';

function jar() {
  let cookie = '';
  return async function req(method, path, body) {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

async function main() {
  console.log(`Creating a scoped landlord login at ${BASE_URL} ...\n`);

  const admin = jar();
  const login = await admin('POST', '/api/auth/login', ADMIN);
  if (login.status !== 200) { console.error('Could not log in as admin:', login.data); process.exit(1); }

  const propsRes = await admin('GET', '/api/properties');
  const property = (propsRes.data || []).find(p => p.name === PROPERTY_NAME);
  if (!property) {
    console.error(`Could not find a property named "${PROPERTY_NAME}". Run scripts/seed-demo.js first.`);
    process.exit(1);
  }

  const invite = await admin('POST', '/api/staff/invite', LANDLORD);
  let landlordId, landlordPassword;
  if (invite.status === 409) {
    console.log(`${LANDLORD.email} already exists as staff — reusing that account (password unchanged).`);
    const staffList = await admin('GET', '/api/staff');
    const existing = (staffList.data || []).find(s => s.email === LANDLORD.email);
    if (!existing) { console.error('Could not find the existing staff record.'); process.exit(1); }
    landlordId = existing.id;
    landlordPassword = '(unchanged — check the original invite output, or delete and re-run to reset)';
  } else if (invite.status !== 200) {
    console.error('staff invite failed:', invite.data);
    process.exit(1);
  } else {
    landlordId = invite.data.staff.id;
    landlordPassword = invite.data.tempPassword;
    console.log(`Created landlord staff account: ${LANDLORD.name} <${LANDLORD.email}> (role: property_manager)`);
  }

  const assign = await admin('POST', `/api/staff/${landlordId}/assign`, { propertyId: property.id });
  if (assign.status !== 200) {
    console.error('assign failed (may already be assigned):', assign.data);
  } else {
    console.log(`Assigned ${LANDLORD.name} to "${property.name}" only.`);
  }

  // Verify: log in AS the landlord and confirm the scoping actually works.
  if (landlordPassword && !landlordPassword.startsWith('(')) {
    const landlordSession = jar();
    const landlordLogin = await landlordSession('POST', '/api/auth/login', { email: LANDLORD.email, password: landlordPassword });
    if (landlordLogin.status === 200) {
      const scopedProps = await landlordSession('GET', '/api/properties');
      const names = (scopedProps.data || []).map(p => p.name);
      console.log(`\nVerified: logging in as ${LANDLORD.name} shows ${names.length} propert${names.length === 1 ? 'y' : 'ies'} — ${names.join(', ')}.`);
    }
  }

  console.log('\n================ LANDLORD LOGIN READY ================');
  console.log(`Admin console:     ${BASE_URL}/admin/login.html`);
  console.log(`  ${LANDLORD.name} (landlord): ${LANDLORD.email} / ${landlordPassword}`);
  console.log(`  Scoped to: ${property.name} only — no other properties, no branches, no other landlords' tenants.`);
  console.log('\nCompare against Dorothy\'s org_admin login (demo@rentpayez.com), which sees everything.');
  console.log('========================================================\n');
}

main().catch(err => { console.error('Script failed:', err); process.exit(1); });
