import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Responsive, WidthProvider, type Layout, type Layouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { fmtMonthLong, monthOf } from "@taktwerk/domain";
import { loadLocal, saveLocal, useStore } from "../store";
import { Icon } from "../ui/components";
import { WIDGETS, type WidgetConfig } from "../widgets/registry";

const Grid = WidthProvider(Responsive);

interface Item {
  i: string;
  type: string;
  config: WidgetConfig;
}

interface DashboardState {
  items: Item[];
  layouts: Layouts;
}

const DEFAULT_ITEMS: Item[] = [
  { i: "w1", type: "kpi-hours", config: {} },
  { i: "w2", type: "kpi-billable", config: {} },
  { i: "w3", type: "kpi-velocity", config: {} },
  { i: "w4", type: "kpi-risk", config: {} },
  { i: "w5", type: "budget-overview", config: {} },
  { i: "w6", type: "velocity-trend", config: {} },
  { i: "w7", type: "burnup", config: { projectId: "p1" } },
  { i: "w8", type: "recent-entries", config: {} },
  { i: "w9", type: "hours-week", config: {} },
  { i: "w10", type: "team-load", config: {} },
];

const DEFAULT_LG: Layout[] = [
  { i: "w1", x: 0, y: 0, w: 3, h: 3 },
  { i: "w2", x: 3, y: 0, w: 3, h: 3 },
  { i: "w3", x: 6, y: 0, w: 3, h: 3 },
  { i: "w4", x: 9, y: 0, w: 3, h: 3 },
  { i: "w5", x: 0, y: 3, w: 7, h: 8 },
  { i: "w6", x: 7, y: 3, w: 5, h: 8 },
  { i: "w7", x: 0, y: 11, w: 7, h: 8 },
  { i: "w8", x: 7, y: 11, w: 5, h: 8 },
  { i: "w9", x: 0, y: 19, w: 7, h: 7 },
  { i: "w10", x: 7, y: 19, w: 5, h: 7 },
];

const EMPLOYEE_ITEMS: Item[] = [
  { i: "e1", type: "kpi-hours", config: {} },
  { i: "e2", type: "kpi-billable", config: {} },
  { i: "e5", type: "kpi-overtime", config: {} },
  { i: "e6", type: "kpi-vacation", config: {} },
  { i: "e3", type: "recent-entries", config: {} },
  { i: "e4", type: "hours-week", config: {} },
];
const EMPLOYEE_LG: Layout[] = [
  { i: "e1", x: 0, y: 0, w: 3, h: 3 },
  { i: "e2", x: 3, y: 0, w: 3, h: 3 },
  { i: "e5", x: 6, y: 0, w: 3, h: 3 },
  { i: "e6", x: 9, y: 0, w: 3, h: 3 },
  { i: "e3", x: 0, y: 3, w: 5, h: 9 },
  { i: "e4", x: 5, y: 3, w: 7, h: 9 },
];

const COLS = { lg: 12, md: 8, sm: 1 };
const BREAKPOINTS = { lg: 1100, md: 640, sm: 0 };

function defaults(employee: boolean): DashboardState {
  return employee ? { items: EMPLOYEE_ITEMS, layouts: { lg: EMPLOYEE_LG } } : { items: DEFAULT_ITEMS, layouts: { lg: DEFAULT_LG } };
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 11 ? "Guten Morgen" : h < 17 ? "Guten Tag" : "Guten Abend";
}

export function Dashboard({ firstName }: { firstName: string }) {
  const { role, data, mode } = useStore();
  const employee = role === "employee";
  const key = `rt.dashboard.${employee ? "employee" : "lead"}`;
  const [state, setStateRaw] = useState<DashboardState>(() => loadLocal(key, defaults(employee)));
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  // Signed in: the layout is stored per user on the server (saved shortly after the last change).
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (mode !== "api") return;
    api<{ layout: DashboardState | null }>("/api/dashboard").then((r) => r.layout?.items && setStateRaw(r.layout)).catch(() => {});
  }, [mode]);

  const setState = (s: DashboardState) => {
    setStateRaw(s);
    saveLocal(key, s);
    if (mode === "api") {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => api("/api/dashboard", { method: "PUT", body: { layout: s } }).catch(() => {}), 800);
    }
  };

  const items = state.items.filter((it) => WIDGETS[it.type] && !(employee && WIDGETS[it.type].restricted));
  const catalog = Object.entries(WIDGETS).filter(([, w]) => !(employee && w.restricted));

  const addWidget = (type: string) => {
    const def = WIDGETS[type];
    const i = `w${Date.now().toString(36)}`;
    const lg = [...(state.layouts.lg ?? []), { i, x: 0, y: Infinity, w: def.w, h: def.h }];
    setState({ items: [...state.items, { i, type, config: {} }], layouts: { ...state.layouts, lg } });
    setCatalogOpen(false);
  };

  const removeWidget = (i: string) =>
    setState({
      items: state.items.filter((x) => x.i !== i),
      layouts: Object.fromEntries(Object.entries(state.layouts).map(([bp, l]) => [bp, l.filter((x) => x.i !== i)])),
    });

  const setConfig = (i: string, config: WidgetConfig) =>
    setState({ ...state, items: state.items.map((x) => (x.i === i ? { ...x, config } : x)) });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greeting()}, {firstName}</h1>
          <p className="sub">{fmtMonthLong(monthOf(data.today))} · {employee ? "Meine Zahlen" : "Alle Kunden und Projekte"}</p>
        </div>
        <div className="toolbar">
          {editing && (
            <>
              <button className="btn" onClick={() => setCatalogOpen((v) => !v)}>+ Widget hinzufügen</button>
              <button className="btn ghost" onClick={() => setState(defaults(employee))}>Zurücksetzen</button>
            </>
          )}
          <button className={`btn ${editing ? "primary" : ""}`} onClick={() => { setEditing((v) => !v); setCatalogOpen(false); }}>
            {editing ? "Fertig" : "Dashboard anpassen"}
          </button>
        </div>
      </div>

      {editing && (
        <div className="notice">Widgets am Griff ziehen, an der Ecke unten rechts in der Grösse ändern, mit × entfernen. Die Anordnung wird in diesem Browser gespeichert.</div>
      )}

      {catalogOpen && (
        <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2>Widget hinzufügen</h2>
          <div className="catalog">
            {catalog.map(([type, w]) => (
              <button key={type} onClick={() => addWidget(type)}>
                <strong>{w.title}</strong>
                <small>{w.description}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={editing ? "editing" : ""} style={{ margin: "0 -8px" }}>
        <Grid
          className="layout"
          layouts={state.layouts}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={40}
          margin={[16, 16]}
          containerPadding={[8, 0]}
          isDraggable={editing}
          isResizable={editing}
          draggableHandle=".drag-handle"
          onLayoutChange={(_: Layout[], all: Layouts) => setState({ ...state, layouts: all })}
        >
          {items.map((it) => {
            const def = WIDGETS[it.type];
            const props = { config: it.config, setConfig: (c: WidgetConfig) => setConfig(it.i, c) };
            const lg = state.layouts.lg?.find((l) => l.i === it.i);
            return (
              <div key={it.i} data-grid={{ x: 0, y: Infinity, w: def.w, h: def.h, ...lg, minW: def.minW, minH: def.minH }}>
                <section className="card widget" aria-label={def.title}>
                  <header className="widget-head">
                    <span className="drag-handle" title="Verschieben"><Icon.grip /></span>
                    <h2>{def.title}</h2>
                    {def.HeaderControl && <def.HeaderControl {...props} />}
                    <button className="btn ghost small widget-remove" aria-label={`${def.title} entfernen`} onClick={() => removeWidget(it.i)}>
                      <Icon.close />
                    </button>
                  </header>
                  <div className={`widget-body ${def.scroll ? "scroll" : ""}`}>
                    <def.Body {...props} />
                  </div>
                </section>
              </div>
            );
          })}
        </Grid>
      </div>
    </>
  );
}
