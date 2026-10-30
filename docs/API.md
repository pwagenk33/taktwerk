# TrackInsight API und Webhooks

The public API is for other systems: BI tools such as Power BI, ticket systems, ERP and payroll. It is part of the Business package; self-hosted installations have it without limits. The complete description as OpenAPI 3.1 is at `/api/v1/openapi.json`. It can be imported into Postman, Insomnia or a code generator.

## Key

An admin creates keys under **Settings → API**. The key is shown once; TrackInsight only stores its SHA-256 fingerprint.

- **Read only:** for evaluations; every `POST`, `PATCH` and `DELETE` answers 403.
- **Read and write:** may also create, change and delete bookings.

A key acts with the rights of the admin who created it. If that person is deactivated, the key stops working. Revoke keys you no longer need.

```bash
curl -H "Authorization: Bearer ti_…" https://firma.trackinsight.ch/api/v1/customers
```

Limit: 300 requests per minute and key (then 429). Errors come as `{"error": "…"}` in the language of the `Accept-Language` header (de, fr, en).

## Endpoints

| Method | Path | Content |
|---|---|---|
| GET | `/api/v1/me` | Organization, key rights |
| GET | `/api/v1/customers` | Customers with hourly rates, currency, language |
| GET | `/api/v1/projects` | Projects with sub-projects, budgets, Jira keys |
| GET | `/api/v1/employees` | People with role, workload, personnel number |
| GET | `/api/v1/time-entries?from=&to=` | Bookings (at most one year, `employeeId`, `projectId`, `limit` ≤ 1000, `offset`) |
| POST | `/api/v1/time-entries` | New booking: `subProjectId`, `date`, `hours`, `reason`, optional `employeeId`, `billable`, `startTime`, `jiraIssueKey` |
| PATCH | `/api/v1/time-entries/{id}` | Change a booking |
| DELETE | `/api/v1/time-entries/{id}` | Delete a booking |
| GET | `/api/v1/expenses?from=&to=` | Expenses with category, status, VAT |
| GET | `/api/v1/absences?from=&to=` | Absences that overlap the period |
| GET | `/api/v1/budgets` | Per project and sub-project: budget, actual cost, remaining budget, story points, forecast, status |
| GET | `/api/v1/invoices` | Invoices with status and amounts |

Writing follows the same rules as the app: closed months are locked, the hourly rate is taken from the customer on the booking date, and every change appears in the history.

## Webhooks

Under **Settings → API → Webhooks** an admin enters an HTTPS address and picks events (or all). Only public addresses are accepted. TrackInsight sends each event as a `POST`:

```json
{
  "id": "6f1c…",
  "type": "time_entry.created",
  "createdAt": "2026-10-30T09:12:44.120Z",
  "data": { "id": "…", "userId": "…", "subProjectId": "…", "date": "2026-10-30", "hours": 1.5, "reason": "…", "actorId": "…" }
}
```

Events: `time_entry.created|updated|deleted`, `expense.created|updated|deleted|submitted|approved|rejected`, `absence.created|approved|rejected|deleted`, `month.submitted|approved|reopened`, `invoice.created|sent|paid|cancelled`. For a deletion, `data` holds the last state.

**Headers:** `TrackInsight-Event`, `TrackInsight-Delivery` (unique per delivery, for deduplication) and `TrackInsight-Signature: t=<unix seconds>,v1=<hex>`. `v1` is the HMAC-SHA256 of `<t>.<raw body>` with the webhook's secret (button «Geheimnis»). Check the signature and reject old timestamps (for example older than 5 minutes):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

**Delivery:** Any 2xx answer within 10 seconds counts as delivered. Otherwise TrackInsight tries again after 1, 5 and 30 minutes, then after 2, 6, 12 and 24 hours. After that it gives up. If 50 deliveries in a row fail, the webhook switches itself off. The **Verlauf** button shows the last 50 deliveries, and **Testen** sends a `ping` event. Events can arrive more than once and out of order. Use `TrackInsight-Delivery` and `createdAt` to handle that.
