import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { login, setup } from "./helpers";

let t: Awaited<ReturnType<typeof setup>>;
let lead: string, lea: string, jonas: string;
let entryId: string;

beforeAll(async () => {
  t = await setup();
  [lead, lea, jonas] = await Promise.all(["marco.brunner", "lea.meier", "jonas.weber"].map(async (u) => (await login(t.app, u)).cookie));
  const d = (await get("/api/dataset", lea)).json();
  const res = await send("POST", "/api/time-entries", lea, { subProjectId: d.subProjects[0].id, date: "2026-10-08", hours: 3, reason: "Konzept" });
  entryId = res.json().id;
});
afterAll(async () => {
  await t.app.close();
  await t.pool.end();
});

const get = (url: string, cookie: string) => t.app.inject({ method: "GET", url, headers: { cookie } });
const send = (method: "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload: object = {}) => t.app.inject({ method, url, headers: { cookie }, payload });

describe("comments and questions on bookings", () => {
  it("a lead's question mails the owner and stays open until the owner answers", async () => {
    t.mailer.outbox.length = 0;
    const q = await send("POST", `/api/time-entries/${entryId}/comments`, lead, { text: "War das wirklich 3 h?", question: true });
    expect(q.statusCode).toBe(200);
    expect(q.json()).toMatchObject({ kind: "question", authorName: "Marco Brunner" });
    expect(t.mailer.outbox).toHaveLength(1);
    expect(t.mailer.outbox[0].to).toBe("lea.meier@beispiel.ch");
    expect(t.mailer.outbox[0].subject).toContain("Rückfrage");

    expect((await get("/api/comments/open", lea)).json()).toMatchObject([{ entryId, text: "War das wirklich 3 h?", askedBy: "Marco Brunner" }]);
    expect((await get("/api/comments/open", lead)).json()).toHaveLength(1);
    // Other employees see nothing and cannot read the thread.
    expect((await get("/api/comments/open", jonas)).json()).toEqual([]);
    expect((await get(`/api/time-entries/${entryId}/comments`, jonas)).statusCode).toBe(403);

    const a = await send("POST", `/api/time-entries/${entryId}/comments`, lea, { text: "Ja, inkl. Vorbereitung." });
    expect(a.json()).toMatchObject({ kind: "comment" });
    expect((await get("/api/comments/open", lea)).json()).toEqual([]);
    const thread = (await get(`/api/time-entries/${entryId}/comments`, lead)).json();
    expect(thread.map((c: { kind: string }) => c.kind)).toEqual(["question", "comment"]);
    expect(thread[0].resolvedAt).not.toBeNull();
  });

  it("an owner cannot turn a comment into a question and empty text is refused", async () => {
    const own = await send("POST", `/api/time-entries/${entryId}/comments`, lea, { text: "Notiz", question: true });
    expect(own.json().kind).toBe("comment");
    expect((await send("POST", `/api/time-entries/${entryId}/comments`, lea, { text: "   " })).statusCode).toBe(400);
    expect((await send("POST", `/api/time-entries/gibt-es-nicht/comments`, lead, { text: "x" })).statusCode).toBe(404);
  });
});
