-- Rent Pay Easy — Phase 1 schema
-- Multi-organization hierarchy + role-based accounts + org-level data isolation.
-- Every table that holds customer data carries an organization_id (directly or
-- via a foreign key chain) so isolation can be enforced in application code.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ── Organizations ──────────────────────────────────────────────────────
-- The top-level tenant of the platform: a landlord, property-management
-- company, rental association, or housing authority.
CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'starter',      -- starter | standard | premium
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  emergency_instructions  TEXT,                        -- org-configurable, NOT a 911 replacement
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Organization users (staff) ─────────────────────────────────────────
-- Roles: super_admin | org_admin | branch_manager | property_manager |
--        maintenance_supervisor | maintenance_tech | inspector | office_staff
-- (tenant login is handled separately in `tenants`, since tenants are
-- scoped to a single unit rather than staff-level organization access.)
CREATE TABLE IF NOT EXISTS organization_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE, -- NULL for platform super_admin
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN (
                    'super_admin','org_admin','branch_manager','property_manager',
                    'maintenance_supervisor','maintenance_tech','inspector','office_staff'
                  )),
  status          TEXT NOT NULL DEFAULT 'active',       -- active | invited | disabled
  invite_token    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email) -- global: login resolves a staff account by email alone, across all organizations
);

-- ── Staff assignments ───────────────────────────────────────────────────
-- Scopes a branch_manager/property_manager/maintenance/inspector staff
-- member to specific branches or properties. Org admins have no rows here
-- (they see everything under their organization_id implicitly).
CREATE TABLE IF NOT EXISTS staff_assignments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_user_id UUID NOT NULL REFERENCES organization_users(id) ON DELETE CASCADE,
  branch_id            UUID,   -- FK added after branches table exists
  property_id          UUID,   -- FK added after properties table exists
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Branches / Divisions (optional level) ──────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Properties / Developments ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL, -- optional
  name            TEXT NOT NULL,
  address         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Buildings (optional level) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buildings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Units ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  building_id     UUID REFERENCES buildings(id) ON DELETE SET NULL, -- optional
  unit_number     TEXT NOT NULL,
  monthly_rent    NUMERIC(10,2),
  rent_due_day    INTEGER CHECK (rent_due_day BETWEEN 1 AND 28), -- day of month rent is due; 1-28 to stay valid in every month. NULL = no reminder computed.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill for deployments where the units table already existed before
-- rent_due_day was added above: CREATE TABLE IF NOT EXISTS only runs on
-- first creation, so the inline column definition never reaches an
-- already-existing table (the exact bug that previously dropped
-- maintenance_requests/documents/payments in production). ADD COLUMN IF
-- NOT EXISTS is idempotent and safe to re-run on every boot.
ALTER TABLE units ADD COLUMN IF NOT EXISTS rent_due_day INTEGER CHECK (rent_due_day BETWEEN 1 AND 28);

-- ── Tenants ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id         UUID REFERENCES units(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  password_hash   TEXT,                                  -- set once tenant activates their login
  status          TEXT NOT NULL DEFAULT 'invited',        -- invited | active | moved_out
  avatar_data     TEXT,                                   -- base64-encoded profile photo, optional
  avatar_mime     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

-- Backfill for deployments where the tenants table already existed before
-- avatar_data/avatar_mime were added above — same reasoning as the
-- rent_due_day backfill further up: CREATE TABLE IF NOT EXISTS only runs
-- on first creation, so inline columns never reach an already-existing
-- table. ADD COLUMN IF NOT EXISTS is idempotent and safe to re-run.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS avatar_data TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS avatar_mime TEXT;

-- ── Audit log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id   UUID,
  actor_type      TEXT,          -- organization_user | tenant | super_admin
  action          TEXT NOT NULL, -- e.g. "branch.create", "tenant.import"
  target_type     TEXT,
  target_id       UUID,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Maintenance requests ────────────────────────────────────────────────
-- Filed by a tenant from the portal, worked by staff from the console.
-- property_id is denormalized from unit_id at creation time so staff
-- scoping (scopedPropertyIds) can filter directly without an extra join.
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id         UUID REFERENCES units(id) ON DELETE SET NULL,
  property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
  category        TEXT NOT NULL DEFAULT 'other',   -- plumbing | electrical | appliance | hvac | pest | structural | other
  priority        TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | emergency
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',    -- open | in_progress | resolved | closed
  staff_notes     TEXT,
  photo_data      TEXT,   -- base64-encoded proof photo, optional
  photo_mime      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

-- ── Documents (digital lease / paperwork / e-signature) ─────────────────
-- Staff upload a file for a tenant; if requires_signature is set, the
-- tenant portal shows it as pending until the tenant signs. This is a
-- lightweight typed-name + timestamp + IP audit trail, NOT a DocuSign
-- integration — a real e-signature vendor is a separate paid account the
-- org would need to set up (see chat for why).
CREATE TABLE IF NOT EXISTS documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uploaded_by         UUID REFERENCES organization_users(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  doc_type            TEXT NOT NULL DEFAULT 'other', -- lease | renewal | notice | addendum | other
  file_name           TEXT NOT NULL,
  file_mime           TEXT NOT NULL,
  file_data           TEXT NOT NULL, -- base64-encoded file bytes (portable across real Postgres and the pg-mem test adapter, which doesn't support BYTEA)
  requires_signature  BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'active', -- active | pending_signature | signed
  signed_name         TEXT,
  signed_at           TIMESTAMPTZ,
  signed_ip           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Payments / receipts ──────────────────────────────────────────────────
-- method='manual' rows are recorded by staff (cash/check/money order).
-- method='stripe' rows are created when a tenant completes Stripe Checkout
-- (see routes/tenant.js) — requires the org to set STRIPE_SECRET_KEY.
CREATE TABLE IF NOT EXISTS payments (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id                     UUID REFERENCES units(id) ON DELETE SET NULL,
  amount_cents                INTEGER NOT NULL,
  method                      TEXT NOT NULL DEFAULT 'manual', -- manual | stripe
  status                      TEXT NOT NULL DEFAULT 'paid',   -- pending | paid | failed | refunded
  stripe_checkout_session_id  TEXT,
  receipt_number              TEXT NOT NULL,
  memo                        TEXT,
  recorded_by                 UUID REFERENCES organization_users(id) ON DELETE SET NULL,
  paid_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Goals (tenant-set personal milestones) ───────────────────────────────
-- Real, tenant-editable — not the demo "mortgage roadmap" numbers from the
-- rentpayez.html mockup. A tenant creates their own goals and updates
-- progress themselves; nothing here is auto-calculated from a credit score
-- since no bureau is connected (see documents/README discussion in chat).
CREATE TABLE IF NOT EXISTS goals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  target_note     TEXT,             -- free-text target, e.g. "$25,000" or "Nov 2026"
  progress_pct    INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  status          TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | done
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Inspections (digital move-in / move-out / routine walkthroughs) ─────
-- Staff conduct these from the console: pick a tenant/unit, an inspection
-- type, and record a per-room condition checklist. Tenants can view (not
-- edit) their own unit's inspection history in the portal. Kept simple —
-- one row per room per inspection, each with an optional proof photo,
-- rather than a deep multi-field walkthrough form.
CREATE TABLE IF NOT EXISTS inspections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  unit_id         UUID REFERENCES units(id) ON DELETE SET NULL,
  property_id     UUID REFERENCES properties(id) ON DELETE SET NULL,
  inspection_type TEXT NOT NULL DEFAULT 'routine', -- move_in | move_out | routine
  overall_notes   TEXT,
  conducted_by    UUID REFERENCES organization_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inspection_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id   UUID NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  room            TEXT NOT NULL,                    -- e.g. Kitchen, Bathroom, Living Room, Exterior
  condition       TEXT NOT NULL DEFAULT 'good',      -- good | fair | damaged
  notes           TEXT,
  photo_data      TEXT,                              -- base64-encoded proof photo, optional
  photo_mime      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Sessions (express-session store) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);

-- ── Indexes for org-scoped lookups (every list query filters on these) ──
CREATE INDEX IF NOT EXISTS idx_org_users_org      ON organization_users(organization_id);
CREATE INDEX IF NOT EXISTS idx_branches_org        ON branches(organization_id);
CREATE INDEX IF NOT EXISTS idx_properties_org      ON properties(organization_id);
CREATE INDEX IF NOT EXISTS idx_properties_branch    ON properties(branch_id);
CREATE INDEX IF NOT EXISTS idx_buildings_org        ON buildings(organization_id);
CREATE INDEX IF NOT EXISTS idx_buildings_property   ON buildings(property_id);
CREATE INDEX IF NOT EXISTS idx_units_org            ON units(organization_id);
CREATE INDEX IF NOT EXISTS idx_units_property        ON units(property_id);
CREATE INDEX IF NOT EXISTS idx_tenants_org          ON tenants(organization_id);
CREATE INDEX IF NOT EXISTS idx_tenants_unit          ON tenants(unit_id);
CREATE INDEX IF NOT EXISTS idx_staff_assign_user    ON staff_assignments(organization_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_org            ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expire      ON sessions(expire);
CREATE INDEX IF NOT EXISTS idx_maint_org            ON maintenance_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_maint_tenant         ON maintenance_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_maint_property       ON maintenance_requests(property_id);
CREATE INDEX IF NOT EXISTS idx_documents_org        ON documents(organization_id);
CREATE INDEX IF NOT EXISTS idx_documents_tenant     ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_org         ON payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant      ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_goals_org            ON goals(organization_id);
CREATE INDEX IF NOT EXISTS idx_goals_tenant         ON goals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inspections_org      ON inspections(organization_id);
CREATE INDEX IF NOT EXISTS idx_inspections_tenant   ON inspections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inspections_property ON inspections(property_id);
CREATE INDEX IF NOT EXISTS idx_inspection_items_ins ON inspection_items(inspection_id);

-- ── staff_assignments FK constraints ─────────────────────────────────────
-- Kept as the last statements in this file on principle, even though
-- services/db.js now applies schema.sql one statement at a time
-- (applySchema()), so file ordering can no longer break later statements
-- the way it once did — see chat for the incident where these ALTER
-- TABLEs sat mid-file, always "failed" with 42710 (duplicate_object) on
-- every boot after the first (Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS), and silently stopped every statement that came after them
-- because the whole file used to run as one multi-statement query.
-- Add any future CREATE TABLE/INDEX statements ABOVE this block anyway.
ALTER TABLE staff_assignments
  ADD CONSTRAINT fk_staff_branch   FOREIGN KEY (branch_id)   REFERENCES branches(id)   ON DELETE CASCADE,
  ADD CONSTRAINT fk_staff_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;
