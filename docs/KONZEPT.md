# Konzept: Zeiterfassung & Reporting («TrackInsight»)

Stand 18.10.2026 · Konzept freigegeben, Meilenstein 1 sowie die Pakete «Abrechnung» und «Arbeitszeit & Absenzen» umgesetzt. Berechnungslogik in `packages/domain/src/calc.ts`.

## 1. Ziel in einem Satz

Mitarbeitende buchen Zeit und Spesen mit Grund auf Kunde → Projekt → Subprojekt. Admins und Consultants sehen pro Kunde Budget, Verbrauch, Restbudget und einen Forecast, der aus offenen JIRA-Story-Points und der gemessenen Team-Velocity (Stunden pro SP) entsteht.

## 2. Rollen

| Rolle | Darf |
|---|---|
| Mitarbeitende | Eigene Zeit und Spesen buchen, ändern und löschen, solange der Monat offen ist; Monat einreichen; eigenes Dashboard |
| Consultant | Alles von Mitarbeitenden, plus Reports, Forecast, Velocity; Monate freigeben oder zurückweisen; Kundenreports versenden |
| Admin | Kunden, Sätze, Projekte, Budgets, JIRA-Anbindung, Benutzer, alle Reports; freigegebene Monate wieder öffnen |

## 3. Datenmodell

```
Organisation (Mandant)
├── Team ── Mitarbeitende (Rolle, Pensum, Ferientage, Erfassung ab, Überträge)
│              └── Absenz (Art, von–bis, halbe Tage, Status beantragt/bewilligt/abgelehnt)
├── Kunde ── Stundensatz-Historie (gültig ab, CHF/h)
│   ├── Report-Empfänger (E-Mail-Adressen für den Monatsversand)
│   └── Projekt (Budget, JIRA-Projektschlüssel)
│       └── Subprojekt (Budget, JIRA-Epic)
│           ├── Zeiteintrag (Person, Datum, Stunden, Grund, verrechenbar, Satz-Snapshot, JIRA-Issue optional)
│           ├── Spese (Person, Datum, Betrag, Kategorie, Grund, Beleg, verrechenbar)
│           └── JIRA-Issue (Key, SP, Status, erledigt am) ← Sync
├── Velocity-Snapshot (Team, Monat, SP, Stunden, h/SP)   ← geplant, heute live berechnet
├── Monatsabschluss (Person, Monat, eingereicht/freigegeben, von wem)
├── Änderungsprotokoll (wer, wann, was, vorher/nachher)
├── Budget-Alarme (Projekt/Subprojekt, Schwelle 80/95/100 %) · Job-Läufe (Monatsversand)
├── Dashboard-Konfiguration (Person, Widgets + Layout als JSON)
└── Einstellungen (Corporate Design, SSO-Domains, Versandtag, Sollzeit pro Woche, Feiertage)
Benutzer ── Microsoft-/Google-Verknüpfung · Sitzungen · Einladungs-/Reset-Links
```

Umgesetzt als MariaDB-Schema in `server/src/db/schema.ts` (Migrationen in `server/drizzle/`). Geldbeträge als `DECIMAL(12,2)`, alle Tabellen mit `organization_id`.

Wichtige Entscheide:
- **Satz-Snapshot pro Zeiteintrag.** Ändert ein Kunde den Satz (Beispiel Alpenbank: 180 → 190 CHF ab 01.07.2026), bleiben vergangene Buchungen korrekt. Der Forecast rechnet mit dem heute gültigen Satz.
- **Projektbudget ≠ Summe der Subprojekte.** Die Differenz ist eine Reserve und wird separat angezeigt.
- **Grund ist Pflicht**, weil er im Kundenreport erscheint.
- **Abschluss pro Person und Monat.** Offen → eingereicht → freigegeben. Eingereicht sperrt für die Person selbst, freigegeben für alle. Nur Admins öffnen wieder; auch das steht im Änderungsprotokoll.
- Optional später: Satz pro Rolle/Person beim Kunden (Senior/Junior), geplante Spesen im Forecast.

## 4. Velocity (Stunden pro Story Point)

Ein Issue zählt im Monat, in dem es auf *Done* gesetzt wurde, mit **allen** Stunden, die je auf seinen Issue-Key gebucht wurden.

- Monatsfaktor = Σ Stunden / Σ SP der in diesem Monat erledigten Issues
- **Gleitender Schnitt (Standard, 3 Monate):** Σ Stunden / Σ SP über die letzten N Monate. Gewichtet nach SP, kleine Monate verzerren nicht.
- **EWMA (Alternative):** α = 2/(N+1), reagiert schneller auf Trendwechsel.
- Der laufende Monat wird angezeigt, zählt aber erst nach Monatsende.
- Bandbreite = tiefster und höchster Monatsfaktor im Fenster → optimistischer/pessimistischer Forecast.

Die Beispieldaten bilden genau deinen Fall ab: Monat 1–3 ≈ 3.5 h/SP, danach Anstieg auf ≈ 6.5 h/SP. Der Prototyp misst das aus den Buchungen (Nov 25: 3.7, Sep 26: 6.4 geglättet).

## 5. Budget & Forecast (pro Subprojekt, Projekt = Summe)

```
Verbraucht   = Σ (Stunden × Satz-Snapshot) [verrechenbar] + Σ Spesen [verrechenbar]
Restbudget   = Budget − Verbraucht
Restaufwand  = max(0, offene SP × h/SP − bereits gebuchte h auf offenen Issues) × (1 + Overhead-Anteil)
Forecast     = Verbraucht + Restaufwand × aktueller Kundensatz
Abweichung   = Budget − Forecast
Status       = Im Plan (≤ 95 %) · Knapp (95–100 %) · Überschreitung (> 100 %)
Fertig ca.   = offene SP / Ø erledigte SP pro Monat (letzte 3 Monate)
```

**Overhead-Anteil** = Stunden ohne JIRA-Issue (Meetings, PL, Reviews) ÷ Stunden mit Issue, pro Subprojekt (ab 40 h Historie), sonst teamweit. So fliessen Meetings in den Forecast ein, ohne die Velocity zu verfälschen.

## 5a. Arbeitszeit, Überzeit und Ferien

```
Soll pro Tag   = Sollzeit pro Woche ÷ 5 × Pensum   (Mo–Fr; Feiertag 0, halber Feiertag die Hälfte)
Absenz-Gutschrift = Soll des Tages (halbe Tage: die Hälfte); Kompensation schreibt nichts gut
Ist            = alle gebuchten Stunden des Tages, verrechenbar oder intern
Saldo          = Übertrag + Σ (Ist − (Soll − Gutschrift)) ab «Erfassung ab» bis heute
Ferien übrig   = Anspruch (pro rata ab Erfassungsbeginn) + Übertrag − bezogen − geplant
```

- Der laufende Tag zählt nur so weit, wie schon gebucht ist; der Saldo fällt also nicht jeden Morgen ins Minus.
- **Absenzarten:** Ferien, Kompensation, Weiterbildung und Sonstiges werden beantragt und von Consultants/Admins bewilligt (E-Mail an beide Seiten). Krankheit, Unfall und Militär/Zivildienst gelten sofort. Absenzen folgen den Monatssperren.
- **Feiertage** pro Organisation unter Einstellungen → Arbeitszeit. Der Vorschlag enthält Neujahr, Berchtoldstag, Karfreitag, Ostermontag, Auffahrt, Pfingstmontag, 1. August, Weihnachten und Stephanstag; kantonale Abweichungen trägt die Admin-Person ein.
- **Datenschutz:** Mitarbeitende sehen nur ihre eigenen Absenzen und ihr eigenes Arbeitsmodell. Die Art einer Absenz (z. B. Krankheit) sehen nur Consultants und Admins.
- **Rechtlicher Hinweis (zu prüfen):** Erfasst wird die tägliche Arbeitszeit als Summe der Buchungen, nicht Beginn, Ende und Pausen. Das entspricht eher der vereinfachten Arbeitszeiterfassung nach Art. 73b ArGV 1, die eine Vereinbarung voraussetzt. Für die volle Erfassung nach Art. 73 bräuchte es zusätzlich Kommen/Gehen und Pausen.

## 6. JIRA-Anbindung

- JIRA Cloud REST API v3 mit OAuth 2.0 (3LO) oder API-Token eines Service-Users.
- Mapping: Projekt ↔ JIRA-Projektschlüssel, Subprojekt ↔ Epic (alternativ Komponente oder Label, pro Projekt wählbar).
- Story-Point-Feld ist pro JIRA-Instanz ein Custom Field (`customfield_100xx`), wird einmal im Admin konfiguriert.
- Sync: Webhook bei Issue-Änderung + nächtlicher Voll-Abgleich. Die Velocity-Snapshots werden danach neu berechnet.
- Zeiteinträge können ein Issue referenzieren (Auswahl der offenen Issues des Subprojekts). Optional später: Worklogs aus JIRA importieren oder zurückschreiben.

## 7. Anmeldung

- **Benutzername + Passwort.** Passwörter mit scrypt gehasht, mindestens 10 Zeichen. Nach 10 Fehlversuchen in 15 Minuten wird gesperrt. Login mit Benutzername oder E-Mail.
- **Microsoft (Entra ID) und Google** über OpenID Connect mit PKCE. Die Buttons erscheinen nur, wenn Client-ID und Secret konfiguriert sind.
- **Wer darf rein?** Personen werden von Admins per E-Mail eingeladen und setzen über den Link ein Passwort oder melden sich direkt mit Microsoft/Google an (Verknüpfung über die E-Mail-Adresse). Optional können Firmen-Domains freigegeben werden; dann wird beim ersten SSO-Login automatisch ein Zugang als Mitarbeitende angelegt.
- **Sitzungen** als httpOnly-Cookie (SameSite=Lax, in der DB nur als Hash gespeichert), 14 Tage gültig. Zusätzlich Herkunftsprüfung gegen CSRF.
- **Passwort vergessen** per E-Mail-Link (1 Stunde gültig, einmalig verwendbar). Die Antwort verrät nicht, ob eine Adresse existiert.

## 8. E-Mail (SMTP)

Versand über einen beliebigen SMTP-Server (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`), z. B. Microsoft 365, Google Workspace oder der eigene Mailserver. Heute: Einladungen, Passwort zurücksetzen, Test-E-Mail, monatlicher Kundenreport mit PDF und Excel im Anhang, Budget-Alarme. Die E-Mails tragen Name und Farbe aus dem Corporate Design. Ohne SMTP-Konfiguration werden sie ins Server-Log geschrieben (Entwicklung).

## 9. Corporate Design

- **Standard Weiss/Rot:** weisse Flächen, Schweizer Rot (#D52B1E) als einzige Akzentfarbe für Navigation, Buttons und Links.
- **Matterhorn-Motiv:** stilisierte Silhouette (Blick von Zermatt) als Logo-Zeichen, grossflächig auf der Anmeldeseite und dezent unten in der Navigation.
- **Konfigurierbar** unter Einstellungen → Erscheinungsbild: Name der Anwendung, Hauptfarbe (Vorlagen oder eigene Farbe) und Motiv ein/aus, mit Live-Vorschau. Gilt für App, Anmeldeseite und E-Mails.
- Diagrammfarben und Ampeln bleiben unabhängig von der Hauptfarbe, damit «Überschreitung» nie mit der Markenfarbe verwechselt wird. Hell- und Dunkelmodus werden unterstützt.

## 10. Architektur & Stack

| Schicht | Wahl | Grund |
|---|---|---|
| Frontend | React + TypeScript + Vite | |
| Charts | Recharts | |
| Widget-Dashboard | react-grid-layout | Layout pro Person in der DB gespeichert |
| Backend | Node.js + TypeScript mit **Fastify** | Schlanker als NestJS, schneller Start; Domänenlogik wird mit dem Frontend geteilt |
| Datenbank | **MariaDB** (ab 10.6) mit Drizzle ORM | Drizzle braucht keine nativen Binaries und erzeugt SQL-Migrationen |
| Auth | eigene Sessions + OIDC (Microsoft, Google) via `arctic` | |
| E-Mail | **SMTP** via Nodemailer | |
| Betrieb | Docker-Image, `docker-compose.yml` mit MariaDB und Mailpit | Läuft beim Kunden on-premise oder in einer Schweizer Cloud |
| Export | PDFKit (PDF), ExcelJS (Excel) | Beide reines JavaScript, keine Systemabhängigkeiten im Docker-Image |
| Hintergrundjobs | Im Server-Prozess alle 15 Minuten, Sperre über die Datenbank | Kein zusätzlicher Dienst nötig |
| Später | JIRA-Sync als Hintergrundjob | |

Aufbau als Monorepo: `packages/domain` (Datenmodell, Velocity, Forecast), `server` (API), `web` (Oberfläche). Eine Installation bedient heute eine Organisation; das Schema ist mandantenfähig.

API: `/api/auth/*`, `/api/dataset`, `/api/reports`, `/api/time-entries`, `/api/expenses`, `/api/customers`, `/api/projects`, `/api/sub-projects`, `/api/users`, `/api/settings`, `/api/dashboard`, `/api/branding`, `/api/months/:monat/(submit|approve|reopen)`, `/api/closings`, `/api/audit/:id`, `/api/customers/:id/report?month=&format=pdf|xlsx`, `/api/customers/:id/recipients`, `/api/customers/:id/report/send`, `/api/absences` (+ `/:id/decide`), `/api/users/:id/work-model`.

## 11. Stand der Umsetzung

- **Dashboard:** 12 Widgets (KPIs, Budget & Forecast, Velocity-Verlauf, Burn-up, Stunden pro Woche/Kunde/Person, letzte Buchungen, Subprojekte nach Abweichung). «Dashboard anpassen» → ziehen, Grösse ändern, entfernen, hinzufügen. Layout bleibt im Browser gespeichert.
- **Zeiterfassung:** Wochenkalender mit Eintrags-Fenster oder Listenansicht (manuell oder Stoppuhr, Favoriten und zuletzt verwendet); Kunde → Projekt → Subprojekt, JIRA-Issue optional, Grund Pflicht; Spesen mit Kategorie, MwSt, Kilometer und Beleg.
- **Kunden & Projekte:** Baum mit Sätzen (inkl. Historie), Budgets, Reserve, JIRA-Schlüssel; Anlegen von Kunde/Projekt/Subprojekt. Projekt anklicken öffnet die Projektseite: Budget, Verbraucht, Forecast, Subprojekte mit JIRA-Tickets (Status, Story Points, gebuchte Stunden), Burn-up; Name, Budget und JIRA-Schlüssel von Projekt und Subprojekten dort bearbeitbar.
- **Reports:** pro Kunde Gesamtbudget, Verbraucht, Restbudget, Forecast mit Bandbreite, Abweichung, Fertigstellung, Status auf Projekt- und Subprojektebene, Burn-up.
- **Velocity:** Methode und Fenster umschaltbar, wirkt sofort auf alle Forecasts.
- **Rollen:** Admin, Consultant, Mitarbeitende; im Prototyp-Link unten links umschaltbar.
- **Einstellungen (Admin):** Erscheinungsbild, Benutzer einladen und verwalten, SSO-Domains, Test-E-Mail.

- **Neu in Meilenstein 1:** Server mit MariaDB, Anmeldung (Passwort, Microsoft, Google), Einladungen und Passwort-Reset per SMTP, Benutzerverwaltung, Corporate Design, Daten und Dashboard-Layout dauerhaft gespeichert.
- Der veröffentlichte Prototyp-Link läuft weiterhin mit Beispieldaten im Browser (Anmeldung dort vorausgefüllt).
- **Neu im Paket «Abrechnung»:**
  - Buchungen und Spesen bearbeiten und löschen, mit Verlauf. Wird das Datum in eine andere Satzperiode verschoben, wird der Satz neu eingefroren.
  - Monatsabschluss: eigene Seite mit «Meine Monate» und für Consultants/Admins die Team-Übersicht mit Freigeben, Zurückweisen und Wieder öffnen. Gesperrte Buchungen zeigen ein Schloss.
  - Kundenreport als PDF (Kacheln, Budget und Forecast pro Projekt/Subprojekt, Leistungsnachweis und Spesen des Monats) und als Excel (Blätter Übersicht, Leistungen, Spesen).
  - Monatlicher Versand an die Empfänger pro Kunde; Versandtag unter Einstellungen → Anmeldung & E-Mail.
  - Budget-Alarm per E-Mail an Admins und Consultants, einmal pro Schwelle und Projekt/Subprojekt.
- **Neu im Paket «Arbeitszeit & Absenzen»:** Überzeit-Saldo, Ferien und Soll/Ist als Kacheln über dem Kalender der Zeiterfassung (Absenzen und Feiertage im Spaltenkopf), Seite «Absenzen» für Ferien- und Absenz-Anträge; für Consultants/Admins offene Anträge, Abwesenheitskalender der nächsten vier Wochen und Team-Übersicht mit Arbeitsmodell pro Person; Soll und Saldo im Monatsabschluss; Dashboard-Widgets «Mein Überzeit-Saldo» und «Meine Ferien übrig»; interne, nicht verrechenbare Stunden über einen Kunden «Intern».
- **Neu im Paket «Erfassen-Komfort»:** Zeiterfassung mit Umschalter Kalender/Liste. Der Kalender zeigt die Woche mit Tagesspalten und Zeitachse (06:00–20:00, 15-Minuten-Raster): auf eine freie Stelle klicken oder ziehen öffnet das Eintrags-Fenster (Kunde → Projekt → Subprojekt, Issue, Grund, Von, Dauer, verrechenbar; Reiter «Spese» für Spesen am selben Tag), Blöcke lassen sich verschieben und unten verlängern, Klick bearbeitet. Buchungen ohne Uhrzeit stehen oben im Tag. Soll und Ist pro Tag im Spaltenkopf, Woche in der Kopfzeile. Favoriten (Stern, pro Person im Browser) und «Zuletzt» (letzte 30 Tage) als Chips im Eintrags-Fenster und in der Listenansicht. Montags ab 09:00 Uhr eine E-Mail, wenn in der Vorwoche mehr als zwei Stunden fehlen (abschaltbar unter Einstellungen → Arbeitszeit).
- **Neu im Paket «Spesen & Rechnung»:** Spesen mit MwSt-Satz (8.1/2.6/3.8/0 %), Kategorie «Kilometer» mit Pauschale pro km (Einstellungen → Rechnung), Beleg als Foto oder PDF (bis 10 MB, abgelegt unter `DATA_DIR/receipts`). Spesen von Mitarbeitenden sind «offen», bis Consultant/Admin sie im Monatsabschluss bewilligt oder mit Begründung ablehnt (E-Mail an die Person, erneut einreichen möglich); nur bewilligte Spesen zählen in Report und Rechnung. Rechnung pro Kunde und Monat unter Reports: Positionen = verrechenbare Stunden pro Subprojekt und Satz plus bewilligte Spesen, Nummer `JJJJ-NNNN`, PDF mit Schweizer QR-Zahlteil (IBAN, Betrag, Adressen), Versand an die Report-Empfänger, Status Entwurf → Versendet → Bezahlt, Storno statt Löschen nach dem Versand. Absender, IBAN, MwSt-Nummer, Zahlungsfrist und Fusstext unter Einstellungen → Rechnung; Rechnungsadresse pro Kunde.
- Noch offen: echte JIRA-Anbindung (Issues kommen heute aus den Beispieldaten). Ein Budget-Alarm wird nicht erneut ausgelöst, wenn das Budget erhöht wird und der Forecast später wieder über die Schwelle steigt.

## 12. Nächste Schritte

1. Git-Repository anlegen und den Stand dort einchecken.
2. JIRA-Anbindung mit einem echten Board (Story-Point-Feld, Epic-Mapping, Sync).
3. Microsoft- und Google-App registrieren (Client-ID/Secret) für die eigene Domain.
4. Optional: Belege automatisch auslesen (Betrag, Datum), Export der Rechnungen an Bexio/Abacus, QR-IBAN mit Referenznummer.
5. Optional: Kommen/Gehen und Pausen für die volle Arbeitszeiterfassung nach ArGV 1.
