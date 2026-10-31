# Importing data

FalconMed Elite can load an export from any queue system as a CSV file. Every row is checked before anything is saved, a quality report shows exactly what was found, and every import can be rolled back in one click.

Open **Import data** (managers and admins). Sample files are in [`frontend/public/samples`](../frontend/public/samples) and downloadable from the page.

## Recommended format

| Column | Required | Example | Notes |
|---|---|---|---|
| `arrived_at` | **yes** | `2026-10-04 08:03:12` | When the ticket was issued |
| `called_at` | | `2026-10-04 08:04:01` | Empty = never called (kept as *left unseen*) |
| `finished_at` | | `2026-10-04 08:07:45` | Empty after a call = kept as *never closed* |
| `ticket_no` | recommended | `A-001` | Used to detect duplicates |
| `branch` | admins | `br_lab` or `Data Import Lab` | Branch id or name. Managers import into their own branch |
| `service_type` | | `prescription` | prescription · refill · consultation · otc · insurance (common labels like *New Rx*, *Repeat*, *Counselling* are understood) |
| `outcome` | | `served` / `no_show` | Also understood: Completed, Missed, Cancelled… |
| `counter_no` | | `2` or `Counter 2` | |
| `pharmacist` | | `ph.ad01.2@demo.falconmed.app` | Email or full name; links the ticket to staff KPIs |
| `identified` | | `yes` / `no` | Patient matched to a record |
| `patient_ref` | | `MRN-482913` | A **de-identified** code only |

Other column names are recognised too (for example *Token No*, *Issue Time*, *Call Time*, *End Time*, *Status*, *Counter*). A separate `Date` column with time-only cells is combined automatically.

**Dates:** ISO (`2026-10-04 08:03`), `DD/MM/YYYY` or `MM/DD/YYYY` (detected from the file itself; UAE default DD/MM), 12-hour times (`08:03 PM`), and Excel serial numbers. Times without an offset are read in the business time zone (`TIMEZONE`, default Asia/Dubai).

**File:** comma, semicolon or tab separated; UTF-8 (Excel: *Save As → CSV UTF-8*); up to 50,000 rows / 8 MB per import.

## Privacy

Columns that identify a person — patient name, mobile, phone, email, Emirates ID, passport, raw MRN, date of birth, address — are **dropped before any value is read**. Any cell that looks like an Emirates ID is never stored, wherever it appears. The report lists what was removed.

## Quality checks

**Rejected rows** (not imported):

| Check | Why |
|---|---|
| Arrival time missing | Nothing can be measured without it |
| Date/time unreadable | e.g. `31/02/2026` |
| Called before arrival | Impossible sequence |
| Finished before called / finished without a call | Impossible sequence |
| Time in the future | Clock or export error |
| Branch not recognised / outside your permission | |
| Duplicate ticket (in the file, or already imported) | Prevents double counting |
| Service type not recognised | |
| No-show that was never called | Contradiction |

**Warnings** (row kept, flagged):

| Check | Treatment |
|---|---|
| Never called | Kept as *left unseen* (`abandoned`) |
| Called but never closed | Kept as *auto-closed*; excluded from service time |
| Wait over 2 hours | Possible data error |
| Service over 45 minutes | Possible data error |
| Service under 6 seconds | Possible accidental click (only checked when the file has seconds) |
| Arrival between 00:00 and 06:00 | Unusual hour |
| Pharmacist / counter / identified value not recognised | Ignored, row kept |

**Quality score** = usable rows ÷ rows in the file. Excellent ≥ 98 % · Good ≥ 90 % · Fair ≥ 75 % · Poor below.

The preview KPIs use the same definitions as the dashboards (see [KPI_DEFINITIONS.md](KPI_DEFINITIONS.md)), so the numbers you see before importing are the numbers you get after.

## Sandbox

The **Data Import Lab** branch exists so imports can be tried without mixing with live branches. Roll an import back from *Import history* to remove all of its tickets.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/imports/validate` | `{ csv, fileName, defaultBranchId? }` → quality report; writes nothing |
| `POST` | `/api/imports` | Same body → validates again and imports valid rows as one batch |
| `GET` | `/api/imports` | Import history visible to the user |
| `DELETE` | `/api/imports/:id` | Roll back a batch and all of its tickets |

Regenerate the sample files with `node backend/scripts/make-samples.js`.
