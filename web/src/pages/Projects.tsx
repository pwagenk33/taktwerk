import { Fragment, useState } from "react";
import { fmt1, fmtCHF, fmtMonth, fmtNum, rateOn, type Project, type SubProject } from "@taktwerk/domain";
import { useStore } from "../store";
import { BurnUpChart, Money, StatusPill } from "../ui/components";

/** Name, budget and JIRA key of a project or sub-project, editable in place by leads. */
function EditableHead({ item, kind, onSave }: { item: Project | SubProject; kind: "project" | "sub"; onSave: (p: { name: string; budget: number; jira: string }) => Promise<void> }) {
  const { role } = useStore();
  const jiraKey = kind === "project" ? (item as Project).jiraProjectKey : (item as SubProject).jiraEpicKey;
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(item.name);
  const [budget, setBudget] = useState(String(item.budget));
  const [jira, setJira] = useState(jiraKey ?? "");
  const [error, setError] = useState("");
  const save = async () => {
    const n = Number(budget);
    if (!name.trim()) return setError("Bitte einen Namen eingeben.");
    if (!(n >= 0)) return setError("Budget muss 0 oder grösser sein.");
    try {
      await onSave({ name: name.trim(), budget: n, jira: jira.trim().toUpperCase() });
      setEdit(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!edit) {
    return (
      <div className="tree-row" style={{ gap: 10, flexWrap: "wrap" }}>
        <div>
          {kind === "project" ? <h2 style={{ margin: 0 }}>{item.name}</h2> : <strong>{item.name}</strong>} {jiraKey && <span className="pill neutral mono">{jiraKey}</span>}
          <div className="muted num" style={{ fontSize: "0.82rem" }}>Budget {fmtCHF(item.budget)}</div>
        </div>
        {role !== "employee" && <button className="btn small" onClick={() => setEdit(true)}>Bearbeiten</button>}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="form-grid" style={{ alignItems: "end" }}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Budget (CHF)</span><input className="input num" type="number" min={0} step={1000} value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
        <label className="field"><span>{kind === "project" ? "JIRA-Projektschlüssel" : "JIRA-Epic"}</span><input className="input mono" value={jira} onChange={(e) => setJira(e.target.value)} /></label>
        <div className="toolbar">
          <button className="btn small primary" onClick={save}>Speichern</button>
          <button className="btn small ghost" onClick={() => setEdit(false)}>Abbrechen</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** One project: figures, sub-projects with their JIRA issues, budgets editable. */
function ProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const { data, reports, updateProject, updateSubProject, notify } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const project = data.projects.find((p) => p.id === projectId)!;
  const customer = data.customers.find((c) => c.id === project.customerId);
  const r = reports.find((x) => x.project.id === projectId);
  const subs = data.subProjects.filter((s) => s.projectId === projectId);
  const subReport = new Map((r?.subs ?? []).map((s) => [s.subProject.id, s]));
  const hoursByIssue = new Map<string, number>();
  for (const e of data.timeEntries) if (e.jiraIssueKey) hoursByIssue.set(e.jiraIssueKey, (hoursByIssue.get(e.jiraIssueKey) ?? 0) + e.hours);
  const allocated = subs.reduce((s, x) => s + x.budget, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn small ghost" onClick={onBack}>‹ Alle Kunden & Projekte</button>
          <h1 style={{ marginTop: 8 }}>{project.name}</h1>
          <p className="sub">{customer?.name} · {fmtCHF(customer ? rateOn(customer, data.today) : 0)}/h</p>
        </div>
        {r && <StatusPill status={r.status} />}
      </div>
      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <EditableHead item={project} kind="project" onSave={async (p) => { await updateProject(project.id, { name: p.name, budget: p.budget, jiraProjectKey: p.jira || undefined }); notify("Projekt gespeichert"); }} />
        <p className="muted num" style={{ fontSize: "0.82rem", margin: "8px 0 0" }}>Auf Subprojekte verteilt {fmtCHF(allocated)} · Reserve <Money v={project.budget - allocated} signed={project.budget - allocated < 0} /></p>
      </section>
      {r && (
        <div className="tiles">
          <div className="card tile"><span className="label">Budget</span><span className="value num">{fmtCHF(r.budget)}</span></div>
          <div className="card tile"><span className="label">Verbraucht</span><span className="value num">{fmtCHF(r.actualCost)}</span><span className="delta num">{fmt1((r.actualCost / Math.max(1, r.budget)) * 100)} % des Budgets</span></div>
          <div className="card tile"><span className="label">Forecast</span><span className="value num">{fmtCHF(r.forecastCost)}</span><span className="delta">Abweichung <Money v={r.variance} signed /></span></div>
          <div className="card tile"><span className="label">Offen</span><span className="value num">{fmtNum(r.spOpen)} SP</span><span className="delta">{fmtNum(r.remainingHours)} h Restaufwand · fertig ca. {r.completionMonth ? fmtMonth(r.completionMonth) : "offen"}</span></div>
        </div>
      )}
      <section className="card">
        <div className="card-head" style={{ paddingBottom: 8 }}><h2>Subprojekte</h2><span className="muted" style={{ fontSize: "0.8rem" }}>Zeile anklicken für die JIRA-Tickets</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Subprojekt</th><th className="r">Budget</th><th className="r">Verbraucht</th><th className="r">Verbleibend</th><th className="r">Offene SP</th><th className="r">Forecast</th><th>Status</th></tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const sr = subReport.get(s.id);
                const issues = data.issues.filter((i) => i.subProjectId === s.id);
                const isOpen = open === s.id;
                return (
                  <Fragment key={s.id}>
                    <tr className="group clickable" onClick={() => setOpen(isOpen ? null : s.id)}>
                      <td><span className={`caret ${isOpen ? "open" : ""}`}>▸</span>{s.name} {s.jiraEpicKey && <span className="mono muted">{s.jiraEpicKey}</span>}</td>
                      <td className="r num">{fmtCHF(s.budget)}</td>
                      <td className="r num">{sr ? fmtCHF(sr.actualCost) : "–"}</td>
                      <td className="r num">{sr ? <Money v={sr.remainingBudget} signed={sr.remainingBudget < 0} /> : "–"}</td>
                      <td className="r num">{sr ? fmtNum(sr.spOpen) : "–"}</td>
                      <td className="r num">{sr ? fmtCHF(sr.forecastCost) : "–"}</td>
                      <td>{sr && <StatusPill status={sr.status} />}</td>
                    </tr>
                    {isOpen && (
                      <tr className="child">
                        <td colSpan={7} style={{ padding: "10px 16px 14px 28px" }}>
                          <div style={{ marginBottom: 10 }}>
                            <EditableHead item={s} kind="sub" onSave={async (p) => { await updateSubProject(s.id, { name: p.name, budget: p.budget, jiraEpicKey: p.jira || undefined }); notify("Subprojekt gespeichert"); }} />
                          </div>
                          {issues.length === 0 ? (
                            <p className="muted" style={{ margin: 0 }}>Keine JIRA-Tickets verknüpft{s.jiraEpicKey ? "" : " (kein Epic hinterlegt)"}.</p>
                          ) : (
                            <table className="data" style={{ fontSize: "0.84rem" }}>
                              <thead><tr><th>Ticket</th><th>Titel</th><th className="r">SP</th><th>Status</th><th className="r">Gebucht</th><th>Erledigt</th></tr></thead>
                              <tbody>
                                {[...issues].sort((a, b) => (a.status === b.status ? a.key.localeCompare(b.key) : a.status === "Done" ? 1 : b.status === "Done" ? -1 : a.status === "In Progress" ? -1 : 1)).map((i) => (
                                  <tr key={i.key}>
                                    <td className="mono">{i.key}</td>
                                    <td>{i.summary}</td>
                                    <td className="r num">{i.storyPoints}</td>
                                    <td><span className={`pill ${i.status === "Done" ? "ok" : i.status === "In Progress" ? "risk" : "neutral"}`}>{i.status === "Done" ? "Erledigt" : i.status === "In Progress" ? "In Arbeit" : "Offen"}</span></td>
                                    <td className="r num">{hoursByIssue.get(i.key) ? `${fmt1(hoursByIssue.get(i.key)!)} h` : "–"}</td>
                                    <td className="num">{i.resolvedAt ? i.resolvedAt.split("-").reverse().join(".") : ""}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {r && (
        <section className="card" style={{ display: "flex", flexDirection: "column", minHeight: 320, marginTop: 16 }}>
          <div className="card-head"><h2>Burn-up</h2></div>
          <BurnUpChart report={r} />
        </section>
      )}
    </>
  );
}

type Draft = { kind: "customer" } | { kind: "project"; customerId: string } | { kind: "sub"; projectId: string } | null;

function NewItemForm({ draft, onClose }: { draft: NonNullable<Draft>; onClose: () => void }) {
  const { data, addCustomer, addProject, addSubProject, notify } = useStore();
  const [name, setName] = useState("");
  const [num, setNum] = useState("");
  const [jira, setJira] = useState("");
  const [error, setError] = useState("");

  const labels = {
    customer: { title: "Neuer Kunde", num: "Stundensatz (CHF)", jira: null },
    project: { title: "Neues Projekt", num: "Budget (CHF)", jira: "JIRA-Projektschlüssel" },
    sub: { title: "Neues Subprojekt", num: "Budget (CHF)", jira: "JIRA-Epic" },
  }[draft.kind];

  const save = async () => {
    const n = Number(num);
    if (!name.trim()) return setError("Bitte einen Namen eingeben.");
    if (!(n > 0)) return setError(`${labels.num} muss grösser als 0 sein.`);
    try {
      if (draft.kind === "customer") await addCustomer({ name: name.trim(), rates: [{ validFrom: data.today, hourlyRate: n }] });
      if (draft.kind === "project") await addProject({ customerId: draft.customerId, name: name.trim(), budget: n, jiraProjectKey: jira || undefined });
      if (draft.kind === "sub") await addSubProject({ projectId: draft.projectId, name: name.trim(), budget: n, jiraEpicKey: jira || undefined });
    } catch (e) {
      return setError((e as Error).message);
    }
    notify(`${labels.title.replace("Neuer ", "").replace("Neues ", "")} «${name.trim()}» angelegt`);
    onClose();
  };

  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2>{labels.title}</h2>
      <div className="form-grid" style={{ alignItems: "end" }}>
        <label className="field"><span>Name</span><input id="n-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field"><span>{labels.num}</span><input id="n-num" type="number" className="input num" value={num} onChange={(e) => setNum(e.target.value)} /></label>
        {labels.jira && <label className="field"><span>{labels.jira}</span><input id="n-jira" className="input mono" value={jira} onChange={(e) => setJira(e.target.value.toUpperCase())} placeholder={draft.kind === "project" ? "z. B. KPR" : "z. B. KPR-4"} /></label>}
        <div className="toolbar">
          <button className="btn primary" onClick={save}>Anlegen</button>
          <button className="btn ghost" onClick={onClose}>Abbrechen</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function Projects() {
  const { data, reports } = useStore();
  const [draft, setDraft] = useState<Draft>(null);
  const [openProject, setOpenProject] = useState<string | null>(null);
  if (openProject && data.projects.some((p) => p.id === openProject)) return <ProjectDetail projectId={openProject} onBack={() => setOpenProject(null)} />;
  const subReport = new Map(reports.flatMap((r) => r.subs.map((s) => [s.subProject.id, s] as const)));
  const projReport = new Map(reports.map((r) => [r.project.id, r]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kunden & Projekte</h1>
          <p className="sub">Projekt anklicken für Budget, Forecast, Subprojekte und JIRA-Tickets. Jeder Kunde hat einen eigenen Stundensatz mit Gültigkeitsdatum.</p>
        </div>
        <button className="btn primary" onClick={() => setDraft({ kind: "customer" })}>+ Kunde</button>
      </div>
      {draft && <NewItemForm key={JSON.stringify(draft)} draft={draft} onClose={() => setDraft(null)} />}
      <section className="card">
        {data.customers.map((c) => {
          const projects = data.projects.filter((p) => p.customerId === c.id);
          const history = [...c.rates].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
          return (
            <div className="tree-customer" key={c.id}>
              <div className="tree-row">
                <div>
                  <h2>{c.name}</h2>
                  <div className="muted" style={{ fontSize: "0.82rem" }}>
                    {fmtCHF(rateOn(c, data.today))}/h
                    {history.length > 1 && ` · seit ${history.at(-1)!.validFrom.split("-").reverse().join(".")}, vorher ${fmtCHF(history.at(-2)!.hourlyRate)}/h`}
                  </div>
                </div>
                <button className="btn small" onClick={() => setDraft({ kind: "project", customerId: c.id })}>+ Projekt</button>
              </div>
              {projects.map((p) => {
                const r = projReport.get(p.id);
                const subs = data.subProjects.filter((s) => s.projectId === p.id);
                const allocated = subs.reduce((s, x) => s + x.budget, 0);
                return (
                  <div className="tree-project" key={p.id}>
                    <div className="tree-row">
                      <div>
                        <button className="link-btn" onClick={() => setOpenProject(p.id)}><strong>{p.name}</strong></button> {p.jiraProjectKey && <span className="pill neutral mono">{p.jiraProjectKey}</span>}
                        <div className="muted num" style={{ fontSize: "0.8rem" }}>
                          Budget {fmtCHF(p.budget)} · davon verteilt {fmtCHF(allocated)} · Reserve {fmtCHF(p.budget - allocated)}
                        </div>
                      </div>
                      <div className="toolbar">
                        {r && <StatusPill status={r.status} />}
                        <button className="btn small ghost" onClick={() => setDraft({ kind: "sub", projectId: p.id })}>+ Subprojekt</button>
                      </div>
                    </div>
                    {subs.map((s) => {
                      const sr = subReport.get(s.id);
                      return (
                        <div className="tree-sub clickable" key={s.id} onClick={() => setOpenProject(p.id)}>
                          <span>{s.name} {s.jiraEpicKey && <span className="mono muted">{s.jiraEpicKey}</span>}</span>
                          <span className="num">
                            {fmtCHF(s.budget)}{sr ? ` · ${sr.spOpen} SP offen` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>
    </>
  );
}
