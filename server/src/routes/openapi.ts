// OpenAPI description of the public API v1, served at /api/v1/openapi.json and described in docs/API.md.
import { EVENT_TYPES } from "../events";

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const nullable = (s: object) => ({ anyOf: [s, { type: "null" }] });
const date = { type: "string", format: "date" };
const list = (ref: string, paged = false) => ({
  type: "object",
  properties: { data: { type: "array", items: { $ref: `#/components/schemas/${ref}` } }, ...(paged ? { total: { type: "integer" }, limit: { type: "integer" }, offset: { type: "integer" } } : {}) },
});
const ok = (schema: object) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
const q = (name: string, required: boolean, schema: object = str, description?: string) => ({ name, in: "query", required, schema, ...(description ? { description } : {}) });
const range = [q("from", true, date), q("to", true, date)];
const paging = [q("limit", false, { type: "integer", minimum: 1, maximum: 1000, default: 200 }), q("offset", false, { type: "integer", minimum: 0, default: 0 })];

const TimeEntryInput = {
  type: "object",
  required: ["subProjectId", "date", "hours", "reason"],
  properties: { employeeId: { ...str, description: "Default: the admin the key belongs to" }, subProjectId: str, date, hours: { ...num, exclusiveMinimum: 0, maximum: 24 }, reason: str, billable: bool, startTime: { ...str, pattern: "^\\d{2}:\\d{2}$" }, jiraIssueKey: str },
};

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "TrackInsight API",
    version: "1.0.0",
    description: "Read customers, projects, bookings, expenses, absences, budgets and invoices; create and change bookings. Authenticate with an API key from Settings → API as `Authorization: Bearer ti_…`. At most 300 requests per minute and key. Errors come as `{ \"error\": \"…\" }` in the language of `Accept-Language` (de, fr, en).",
  },
  servers: [{ url: "/" }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "API key, e.g. ti_AbC…" } },
    schemas: {
      Customer: { type: "object", properties: { id: str, name: str, currency: str, language: str, rates: { type: "array", items: { type: "object", properties: { validFrom: date, hourlyRate: num } } } } },
      Project: { type: "object", properties: { id: str, customerId: str, name: str, budget: num, kind: { enum: ["tm", "fixed", "retainer"] }, jiraProjectKey: nullable(str), leadUserId: nullable(str), subProjects: { type: "array", items: { type: "object", properties: { id: str, name: str, budget: num, jiraEpicKey: nullable(str) } } } } },
      Employee: { type: "object", properties: { id: str, name: str, role: str, teamId: nullable(str), workload: nullable(num), personnelNumber: nullable(str) } },
      TimeEntry: { type: "object", properties: { id: str, date, startTime: nullable(str), hours: num, employeeId: str, employeeName: nullable(str), customerId: nullable(str), projectId: nullable(str), subProjectId: str, reason: str, billable: bool, hourlyRate: num, amount: num, jiraIssueKey: nullable(str) } },
      TimeEntryInput,
      Expense: { type: "object", properties: { id: str, date, employeeId: str, employeeName: nullable(str), customerId: nullable(str), projectId: nullable(str), subProjectId: str, category: str, amount: num, vatRate: nullable(num), km: nullable(num), reason: str, billable: bool, status: { enum: ["requested", "approved", "rejected"] } } },
      Absence: { type: "object", properties: { id: str, employeeId: str, employeeName: nullable(str), type: str, startDate: date, endDate: date, halfDay: bool, status: { enum: ["requested", "approved", "rejected"] } } },
      Budget: { type: "object", properties: { projectId: str, customerId: str, currency: str, budget: num, hoursBooked: num, actualCost: num, remainingBudget: num, storyPointsDone: num, storyPointsOpen: num, remainingHours: num, forecastCost: num, variance: num, status: { enum: ["ok", "risk", "over"] }, subProjects: { type: "array", items: { type: "object" } } } },
      Invoice: { type: "object", properties: { id: str, number: str, customerId: str, month: str, issueDate: date, dueDate: date, status: { enum: ["draft", "sent", "paid", "cancelled"] }, net: num, vatRate: num, vat: num, gross: num, currency: str, sentAt: nullable(str), paidAt: nullable(str) } },
      WebhookEvent: {
        type: "object",
        description: "POSTed to your endpoint. Header TrackInsight-Signature: t=<unix>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\" with the endpoint secret>.",
        properties: { id: str, type: { enum: EVENT_TYPES }, createdAt: { type: "string", format: "date-time" }, data: { type: "object" } },
      },
    },
  },
  paths: {
    "/api/v1/me": { get: { summary: "Key and organization", responses: ok({ type: "object" }) } },
    "/api/v1/customers": { get: { summary: "Customers with hourly rates", responses: ok(list("Customer")) } },
    "/api/v1/projects": { get: { summary: "Projects with sub-projects", responses: ok(list("Project")) } },
    "/api/v1/employees": { get: { summary: "People", responses: ok(list("Employee")) } },
    "/api/v1/time-entries": {
      get: { summary: "Bookings in a period (at most one year)", parameters: [...range, q("employeeId", false), q("projectId", false), ...paging], responses: ok(list("TimeEntry", true)) },
      post: { summary: "Create a booking (key with scope write)", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/TimeEntryInput" } } } }, responses: { "201": { description: "Created" } } },
    },
    "/api/v1/time-entries/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: str }],
      patch: { summary: "Change a booking (closed months are locked)", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/TimeEntryInput" } } } }, responses: ok({ type: "object" }) },
      delete: { summary: "Delete a booking", responses: ok({ type: "object" }) },
    },
    "/api/v1/expenses": { get: { summary: "Expenses in a period", parameters: [...range, ...paging], responses: ok(list("Expense", true)) } },
    "/api/v1/absences": { get: { summary: "Absences overlapping a period", parameters: range, responses: ok(list("Absence")) } },
    "/api/v1/budgets": { get: { summary: "Budget, actual cost and forecast per project and sub-project", responses: ok(list("Budget")) } },
    "/api/v1/invoices": { get: { summary: "Invoices", responses: ok(list("Invoice")) } },
  },
  webhooks: Object.fromEntries(EVENT_TYPES.map((t) => [t, { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } } }, responses: { "200": { description: "Any 2xx confirms the delivery" } } } }])),
};
