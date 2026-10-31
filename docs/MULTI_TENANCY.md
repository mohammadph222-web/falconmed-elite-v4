# Multi-tenancy (organisations)

Since v4.4 one FalconMed deployment can serve several pharmacy groups. Each group is an **organisation**, and everything else hangs off it.

```mermaid
erDiagram
  organizations ||--o{ branches : has
  organizations ||--o{ users : employs
  organizations ||--o{ import_batches : owns
  branches ||--o{ tickets : records
  branches ||--o{ users : "staff (same organisation)"
```

| Table | Organisation link |
|---|---|
| `organizations` | `id`, `name`, `slug`, `plan` (`demo` · `trial` · `starter` · `pro` · `enterprise`), `is_active` |
| `branches` | `org_id` (required) |
| `users` | `org_id` (required). A user's branch must be in the same organisation — enforced by a composite foreign key `(branch_id, org_id) → branches(id, org_id)` |
| `import_batches` | `org_id` (required) |
| `tickets` | through their branch (no extra column, so no extra write cost on the hot path) |

## How isolation is enforced

1. **Every query is filtered on the server.** The signed-in user's `org_id` is loaded from the database on every request (not trusted from the browser). `resolveScope()` puts it in every scope, and the shared `where()` builder always adds `branch_id IN (branches of this organisation)`. Branch lists, the staff table, the branch scorecard, the live board, the importer's branch and pharmacist lookup, import history and rollback all filter by organisation.
2. **Naming another organisation's branch or pharmacist is refused** with 403 (`assertInOrg`), rather than silently returning empty numbers.
3. **The database rejects cross-organisation links** (composite foreign key above).
4. **Suspending an organisation** (`is_active = false`) signs its users out on their next request and blocks sign-in. Other organisations are unaffected.

All of this is covered by `backend/test/tenancy.test.js`.

## Demo organisations

| Organisation | Plan | Branches | Admin sign-in |
|---|---|---|---|
| FalconMed Demo Network | `demo` | 5 + Data Import Lab | `admin@demo.falconmed.app` |
| Oasis Care Pharmacies | `demo` | 2 + Data Import Lab | `admin@oasis.demo.falconmed.app` |

`npm run seed:refresh` and `DEMO_AUTO_REFRESH=true` rebuild **only** organisations whose plan is `demo`. Real organisations are never deleted or changed by the seed script.

## Upgrading from v4.3

Migration `003_organizations.sql` runs automatically on start-up. It creates the `FalconMed Demo Network` organisation and moves every existing branch, user and import into it. No ticket is changed or lost. The second demo organisation appears after the next `npm run seed:refresh` (or automatically on Render with `DEMO_AUTO_REFRESH=true`).

## Not yet included (next stages)

- Self-service sign-up (an organisation settings page arrived in v4.5).
- One queue-machine key per organisation (today `QUEUE_API_KEY` is shared; tickets still land only in the branch named in the request).
- Billing per plan.

## Organisation settings (v4.5)

Organisation admins open **Settings** to manage their own organisation (API: `/api/org`, admin only, always limited to the admin's organisation):

| Rule | Why |
|---|---|
| New accounts get a temporary password and must choose their own at first sign-in (`PASSWORD_CHANGE_REQUIRED` until then) | The admin never knows a user's real password |
| Changing or resetting a password raises the user's `token_version`, which signs out every older session | A lost or shared device stops working at once |
| One active pharmacist per counter; counters 1…branch.counters | The counter console and *Call next* rely on it (also a unique index in the database) |
| A branch with active staff cannot be deactivated; counters cannot be reduced below an occupied counter | Nobody is left assigned to something that no longer exists |
| A pharmacist serving a patient cannot be moved or deactivated until the ticket is closed | No orphaned open tickets |
| Every organisation keeps at least one active admin; admins cannot deactivate or demote themselves | No organisation can lock itself out |
| In `demo` organisations the seeded branches and accounts are protected; visitor additions are editable and removed at the next demo refresh | The public demo keeps working for everyone |
