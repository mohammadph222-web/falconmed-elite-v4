# KPI definitions

Every number in FalconMed Elite comes from one database view, `falconmed_v4.ticket_metrics`, so a metric means the same thing on every screen. Nothing is hard-coded, random, or estimated. When a period has no data, the API returns `null` and the UI shows `—`.

## Ticket lifecycle

```
arrived_at ──(wait)──▶ called_at ──(service)──▶ finished_at
 waiting                 in_service               served | no_show
```

| Status | Meaning |
|---|---|
| `waiting` | Registered by the queue machine, not yet called |
| `in_service` | Called to a counter by a pharmacist |
| `served` | Closed as served by that pharmacist |
| `no_show` | Called, patient did not come to the counter |
| `abandoned` | Still waiting at the end of the business day (left without being seen). Set automatically. |
| `auto_closed` | Called but never closed at the counter by the end of the day. Set automatically; excluded from service-time averages because the end time is unknown. |

## Time measures (minutes)

| Measure | Formula | Counted for |
|---|---|---|
| **Wait** | `called_at − arrived_at` | every called ticket |
| **Service** | `finished_at − called_at` | `served` only |
| **Door-to-done** | `finished_at − arrived_at` | `served` only |

## Headline KPIs

| KPI | Formula | Notes |
|---|---|---|
| Tickets | count of tickets that arrived in the period | |
| Serve rate | `served ÷ (served + no_show)` | Only closed tickets count, so open tickets do not drag it down |
| No-show rate | `no_show ÷ (served + no_show)` | |
| Avg wait | mean wait of called tickets | P90 wait is also reported |
| Within target | `called with wait ≤ target ÷ called` | Target = `WAIT_TARGET_MIN` (default 5 min) |
| Avg service | mean service time of served tickets | |
| Identified | `identified ÷ tickets` | Patient matched to a medical record at registration |
| Change | vs. the previous period of equal length | Rates and minutes: absolute difference (pt / min). Counts: % change. |

### Fair comparison when the period includes today

Today is only partly over, so comparing it with a full previous period would make every morning look like a collapse ("−100 % vs yesterday" at 07:00). When a period ends today, the previous period is cut at the **same point in time**:

| Selected | Compared with |
|---|---|
| Today, at 10:15 | Yesterday until 10:15 |
| Last 7 days, at 10:15 | The 7 days before, until 10:15 on their last day |
| A completed period (e.g. yesterday) | The full previous period |

The API reports which mode was used in `comparison.mode` (`same_time` or `full_period`), and the dashboard labels the deltas accordingly (e.g. "vs yesterday by 10:15").

## Scope

The server decides what each user can see. The browser cannot widen it.

| Role | Sees |
|---|---|
| Pharmacist | Only tickets they called |
| Branch manager | Their branch, every pharmacist in it |
| Network admin | All branches, with drill-down to one branch |

## Branch status bands

Derived from **Within target**:

| Band | Rule |
|---|---|
| On target | ≥ 90 % |
| Watch | 75 – 90 % |
| Action needed | < 75 % |
| No data | no called tickets in the period |

## Live alerts

Computed from the live queue each time it is read:

| Alert | Severity | Rule |
|---|---|---|
| Patient waiting too long | critical | longest current wait > 2 × target |
| Average wait above target | warning | mean wait of patients called in the last 60 min > target |
| Queue building up | warning | waiting > 4 × the branch's counters |
| No counter serving | critical | patients waiting and no counter has called anyone |

## Time zone

Business dates and hours use `TIMEZONE` (default `Asia/Dubai`). Every timestamp is stored as `timestamptz`, and hourly grouping converts it explicitly, so results do not depend on the server's clock settings.
