# Rent Pay Easy — Inspection Report & Phase 1 Implementation Plan

## 1. What currently exists

I inspected `rentpayez.html` (and the `netlify/functions/` backend we added last for Stripe) in full. Here's the honest current state:

**Tech stack:** A single static HTML file (~2,000 lines) with inline CSS and inline JavaScript. No framework, no build step, no npm dependencies for the frontend. The only backend that exists is two Netlify Functions we added in the last session (`create-checkout.js`, `stripe-webhook.js`) — those handle Stripe payments only.

**Database:** None. There is no database anywhere in this project. All "data" — tenants, landlords, properties, payment history, credit scores — lives in a single hardcoded JavaScript object (`const DATA = {...}`) baked into the HTML file. It's demo/mock data: one fake tenant (Sara Kim), one fake landlord (Marcus Reilly), a handful of fake properties and tenants under his portfolio.

**Authentication:** None. There is no login system, no passwords, no sessions, no tokens. Clicking a portal button (`enterPortal('tenant')`, `enterPortal('landlord')`, `enterPortal('admin')`) just sets a JavaScript variable (`CURRENT_ROLE`) in the browser. Anyone can open the file and click into any of the three portals — there is no verification of identity or authorization anywhere.

**Existing structure worth preserving:** The file already has a clean three-portal shell — `TENANT_VIEWS`, `LANDLORD_VIEWS`, `ADMIN_VIEWS` — each a set of render functions keyed by a `NAV` config, plus a sidebar/router (`setView`, `renderView`). This is a reasonable UI skeleton and matches the "one landlord's portfolio" shape you'd expect from a demo, but it has no concept of multiple organizations, only one hardcoded landlord.

**Functionality that works today:** Landing page, pricing section (now wired to real Stripe Checkout for Standard/Premium), a tenant dashboard (pay rent — now real Stripe, view payment history, chat with a canned "AI Coach"), a landlord dashboard (view a portfolio of mock tenants/properties), and a `rentpayez` internal admin view (mock user list, mock fraud/funnel stats). None of it is backed by a real, persisted, multi-user database.

## 2. Gap between what exists and what you're asking for

Everything in your spec — organizations, branches, properties, buildings, units, staff roles enforced server-side, per-org data isolation, maintenance tickets, digital inspections, file storage, notifications, audit logs — requires a real backend and real database that currently do not exist. This isn't a matter of "integrating into" existing tables or APIs; there aren't any yet. What *does* exist and will be preserved: the visual design, branding, logo, existing page layouts, and the Stripe payment flow we just built.

## 3. Proposed technology stack

To keep this consistent with the most similar system already built and proven in this workspace (the multi-tenant AI Receptionist platform), I'm using the same stack:

- **Backend:** Node.js + Express
- **Database:** PostgreSQL (relational — the right fit for a strict org → branch → property → building → unit → tenant hierarchy with foreign-key-enforced isolation)
- **Auth:** bcrypt password hashing + server-side sessions (`express-session`), same pattern as the AI Receptionist
- **File storage (Phase 2+, for maintenance/inspection media):** not implemented yet — will use a private object-storage bucket (e.g., Cloudflare R2 or S3-compatible), never storing binary media in Postgres rows
- **Authorization:** every API route enforces organization scoping and role checks server-side via middleware — never trusting a client-sent `organizationId`. This directly satisfies your "enforce at the database/API level, not just hidden buttons" requirement.

## 4. What's being built / changed

Since nothing backend-related exists yet, Phase 1 is net-new, added alongside the existing `rentpayez.html` (which is not being modified in Phase 1):

**New project folder:** `rentpayez-platform/` — Express server, Postgres schema, and a new lightweight admin console (separate from the existing demo pages).

**New database tables (Phase 1):**
`organizations`, `organization_users` (staff, with a `role` column and optional `branch_id`/`property_id` scoping), `branches`, `properties`, `buildings`, `units`, `tenants`, `staff_assignments`, `audit_logs`, plus `sessions` for auth.

**New API surface (Phase 1):** signup/login/logout, CRUD for branches/properties/buildings/units, invite staff + assign to branch/property, add tenant individually, CSV tenant import, assign tenant to unit, and an organization-scoped summary/report endpoint. Every one of these enforces role + org-scoping in middleware, not just in the UI.

**New minimal UI (Phase 1):** a org-admin console page for managing the hierarchy (create branches/properties/buildings/units, invite staff, import tenants via CSV) — built in the same visual language (colors, fonts, card style) as the existing Rent Pay Easy pages, but as new pages, not a redesign of the working tenant/landlord/admin demo views.

**Not touched in Phase 1:** `rentpayez.html`'s existing tenant/landlord/admin demo portals, the logo, the Stripe integration, or any existing working page.

## 5. Phase 1 scope (this pass only)

Multi-organization hierarchy (org → branch → property → building → unit → tenant, with every level optional except org/property/unit), role-based accounts (all 9 roles from your spec exist as a `role` enum, though only org-management permissions are enforced this phase — maintenance/inspection permissions come in Phase 2/3), and verified data isolation between two different organizations (I'll create two test orgs and confirm neither can see the other's data through the API).

Maintenance alerts and digital inspections are explicitly **out of scope for this pass** — those are Phases 2 and 3, per your instructions, and I won't start them until Phase 1 is tested and you've reviewed it.

## 6. What I'll need from you before this goes live (not blocking Phase 1 dev/test)

A Postgres database to deploy to (Railway, Render, Supabase, or similar — I can scaffold against a local/test Postgres instance for now and hand you deploy instructions when Phase 1 is ready, same as we did for the AI Receptionist). No credentials are needed yet — I'll flag exactly what's needed when Phase 1 is done.
