// Stamping without searching for the button: an NFC tag or QR code at the entrance opens #stempeln/<token>, and
// companies can require the location for stamps in the app (checked on the server, never stored).
import { stampOptions, type StampAction } from "@taktwerk/domain";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { tr } from "../i18n";

const LABEL: Record<StampAction, string> = { in: tr("Kommen"), break: tr("Pause"), resume: tr("Weiter"), out: tr("Gehen") };

/** Current position for the geofence; rejects when the person declines or the device has none. */
export function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error(tr("Dieses Gerät kann keinen Standort liefern.")));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => reject(new Error(tr("Ohne Standort geht das Stempeln hier nicht. Bitte den Standort für diese Seite erlauben."))),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

interface Landing { name: string; state: "off" | "working" | "break"; since: string | null; options: StampAction[]; now: string }

/** Page behind an NFC tag or QR code: one big button for what fits now. */
export function StampLanding() {
  const { mode, notify, reload, stamp } = useStore();
  const token = location.hash.split("/")[1] ?? "";
  const [info, setInfo] = useState<Landing | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode === "demo") return setInfo({ name: tr("Eingang Werkstatt"), state: "off", since: null, options: stampOptions("off"), now: new Date().toTimeString().slice(0, 5) });
    api<Landing>(`/api/presence/point/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError((e as Error).message));
  }, [token, mode]);

  const go = async (action: StampAction) => {
    setBusy(true);
    try {
      if (mode === "api") {
        const r = await api<{ now: string }>("/api/presence/stamp", { body: { action, point: token } });
        await reload();
        setDone(tr("{0} um {1} gestempelt", LABEL[action], r.now));
      } else {
        await stamp(action);
        setDone(tr("{0} um {1} gestempelt", LABEL[action], info?.now ?? ""));
      }
      notify(tr("Gestempelt"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stamp-landing">
      <section className="card card-pad">
        <p className="eyebrow">{tr("Stempelpunkt")}</p>
        <h1>{info?.name ?? "…"}</h1>
        {error && <p className="error">{error}</p>}
        {done ? (
          <>
            <p className="stamp-done">{done}</p>
            <a className="btn block" href="#zeit">{tr("Zur Zeiterfassung")}</a>
          </>
        ) : info && (
          <>
            <p className="muted">{info.state === "working" ? tr("Am Arbeiten seit {0}", info.since ?? "") : info.state === "break" ? tr("Pause seit {0}", info.since ?? "") : tr("Noch nicht gestempelt")}</p>
            <div className="stamp-landing-actions">
              {info.options.map((a, i) => (
                <button key={a} id={`point-${a}`} className={`btn ${i === 0 ? "primary" : ""} big`} disabled={busy} onClick={() => void go(a)}>{LABEL[a]}</button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

interface Point { id: string; name: string; lat: number | null; lng: number | null; radius: number | null; url: string }
interface PointsState { points: Point[]; geofence: boolean }

const DEMO_POINTS: PointsState = {
  points: [
    { id: "sp1", name: tr("Eingang Werkstatt"), lat: 47.3779, lng: 8.5403, radius: 120, url: "https://beispiel.trackinsight.app/#stempeln/demo" },
    { id: "sp2", name: tr("Baustelle Seefeld"), lat: null, lng: null, radius: null, url: "https://beispiel.trackinsight.app/#stempeln/demo2" },
  ],
  geofence: false,
};

/** Settings → Arbeitszeit (come/go): stamp points with NFC link, QR code and optional location. */
export function StampPointsCard() {
  const { mode, notify } = useStore();
  const demo = mode === "demo";
  const [s, setS] = useState<PointsState | null>(demo ? DEMO_POINTS : null);
  const [name, setName] = useState("");
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState("150");
  const [error, setError] = useState("");
  useEffect(() => { if (!demo) api<PointsState>("/api/presence/points").then(setS).catch((e) => setError((e as Error).message)); }, [demo]);
  if (!s) return error ? <p className="error">{error}</p> : null;

  const run = async (fn: () => Promise<PointsState>, msg: string) => {
    if (demo) return notify(tr("Im Prototyp wird nichts gespeichert."));
    try { setS(await fn()); setError(""); notify(msg); } catch (e) { setError((e as Error).message); }
  };
  const here = async () => {
    try { const p = await currentPosition(); setPos({ lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 }); } catch (e) { setError((e as Error).message); }
  };
  const writeTag = async (p: Point) => {
    try {
      const Reader = (window as unknown as { NDEFReader?: new () => { write: (m: { records: { recordType: string; data: string }[] }) => Promise<void> } }).NDEFReader;
      if (!Reader) return notify(tr("Dieses Gerät kann keine NFC-Tags beschreiben. Den Link mit einer NFC-App auf den Tag schreiben."));
      notify(tr("Tag jetzt ans Handy halten …"));
      await new Reader().write({ records: [{ recordType: "url", data: p.url }] });
      notify(tr("NFC-Tag beschrieben"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copy = (url: string) => { void navigator.clipboard?.writeText(url); notify(tr("Link kopiert")); };

  return (
    <section className="card card-pad" id="stamp-points" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0 }}>{tr("Stempelpunkte (NFC, QR-Code, Standort)")}</h3>
      <p className="explain" style={{ margin: 0 }}>{tr("Ein NFC-Aufkleber oder QR-Code am Eingang öffnet die Stempelseite: Handy hinhalten, «Kommen» tippen. Funktioniert auf iPhone und Android ohne eigene App.")}</p>
      {s.points.length > 0 && (
        <ul className="point-list">
          {s.points.map((p) => (
            <li key={p.id}>
              <div style={{ minWidth: 0 }}>
                <strong>{p.name}</strong>
                <div className="muted" style={{ fontSize: "0.8rem" }}>{p.lat !== null ? tr("Standort hinterlegt, Umkreis {0} m", p.radius ?? 150) : tr("ohne Standort")}</div>
              </div>
              <div className="toolbar" style={{ gap: 6 }}>
                <button className="btn small" onClick={() => copy(p.url)}>{tr("Link")}</button>
                <a className="btn small" href={demo ? undefined : `/api/presence/points/${p.id}/qr.svg`} target="_blank" rel="noreferrer" onClick={(e) => { if (demo) { e.preventDefault(); notify(tr("Im Prototyp gibt es keinen QR-Code.")); } }}>{tr("QR-Code")}</a>
                <button className="btn small" onClick={() => void writeTag(p)}>{tr("NFC schreiben")}</button>
                <button className="btn small ghost" title={tr("Neuer Link: alte Aufkleber und QR-Codes gelten nicht mehr.")} onClick={() => void run(() => api<PointsState>(`/api/presence/points/${p.id}`, { method: "PATCH", body: { renewToken: true } }), tr("Neuer Link erstellt"))}>{tr("Neu")}</button>
                <button className="btn small ghost" aria-label={tr("Stempelpunkt löschen")} onClick={() => void run(() => api<PointsState>(`/api/presence/points/${p.id}`, { method: "DELETE" }), tr("Stempelpunkt gelöscht"))}>×</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="partner-form">
        <label className="field"><span>{tr("Name")}</span><input id="sp-name" className="input" placeholder={tr("z. B. Eingang Werkstatt")} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>{tr("Umkreis (m)")}</span><input className="input num" type="number" min={20} max={2000} value={radius} onChange={(e) => setRadius(e.target.value)} /></label>
        <button type="button" className="btn" onClick={() => void here()}>{pos ? tr("Standort: {0}, {1}", pos.lat.toFixed(4), pos.lng.toFixed(4)) : tr("Aktuellen Standort übernehmen")}</button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => void run(async () => { const r = await api<PointsState>("/api/presence/points", { body: { name: name.trim(), ...(pos ? { ...pos, radius: Number(radius) || 150 } : {}) } }); setName(""); setPos(null); return r; }, tr("Stempelpunkt angelegt"))}>{tr("Anlegen")}</button>
      </div>
      <label className="check">
        <input id="sp-geofence" type="checkbox" checked={s.geofence} onChange={(e) => void run(() => api<PointsState>("/api/presence/geofence", { method: "PUT", body: { on: e.target.checked } }), e.target.checked ? tr("Stempeln nur noch am Arbeitsort") : tr("Stempeln überall möglich"))} />
        {tr("Stempeln in der App nur am Arbeitsort erlauben. Das Handy prüft den Standort beim Stempeln; gespeichert wird nur der Stempelpunkt, nie die Koordinaten.")}
      </label>
      {error && <p className="error" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}
