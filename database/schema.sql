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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

-- Now that branches/properties exist, wire up staff_assignments FKs.
ALTER TABLE staff_assignments
  ADD CONSTRAINT fk_staff_branch   FOREIGN KEY (branch_id)   REFERENCES branches(id)   ON DELETE CASCADE,
  ADD CONSTRAINT fk_staff_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;

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
