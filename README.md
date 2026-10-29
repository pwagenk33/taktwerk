# TrackInsight

Zeiterfassung und Kunden-Reporting mit JIRA-basiertem Forecast. Konzept: [docs/KONZEPT.md](docs/KONZEPT.md).

```
packages/domain   Datenmodell, Velocity, Forecast (geteilt von Server und Web)
server            API (Fastify, MariaDB/Drizzle, Login, SMTP)
web               Oberfläche (React, Vite)
```

## Schnellstart mit Docker

```bash
cp .env.example .env
docker compose up -d --build
# Beispieldaten laden (alle Beispiel-Benutzer bekommen das angegebene Passwort):
docker compose run --rm app node server/dist/cli.js seed mein-demo-passwort
# oder leere Installation mit erstem Admin (Einladungslink wird ausgegeben und gemailt):
docker compose run --rm app node server/dist/cli.js init "Firma AG" "Vorname Nachname" admin@firma.ch admin
```

App: http://localhost:3000 · E-Mails landen in Mailpit: http://localhost:8025

## Entwicklung ohne Docker

Voraussetzungen: Node 22, MariaDB ab 10.6 mit Datenbank `taktwerk` (Benutzer/Passwort `taktwerk`, siehe `.env.example`).

```bash
npm install
npm run db:seed -- mein-demo-passwort   # Migrationen + Beispieldaten
npm run dev:server                       # API auf :3000
npm run dev:web                          # Oberfläche auf :5173 (leitet /api an :3000 weiter)
npm test                                 # Domain-Tests + API-Tests (brauchen die Datenbank taktwerk_test)
```

Login mit den Beispieldaten: `anna.keller` (Admin), `marco.brunner` (Consultant), `lea.meier` (Mitarbeiterin).

Schema ändern: `server/src/db/schema.ts` anpassen, dann `npm run db:generate -w server` erzeugt die SQL-Migration in `server/drizzle/`.

## Abrechnung

- **Buchungen bearbeiten und löschen** direkt in der Liste unter Zeiterfassung. Jede Änderung landet im Änderungsprotokoll (Tabelle `audit_log`, in der Oberfläche unter «Verlauf»).
- **Monatsabschluss:** Mitarbeitende reichen den Monat ein, Consultants oder Admins geben frei. Eingereicht: nur noch die Freigabe-Person kann korrigieren. Freigegeben: gesperrt, bis eine Admin-Person den Monat wieder öffnet.
- **Kundenreport** unter Reports → Kunde wählen: PDF und Excel im Corporate Design, «Jetzt senden» an die hinterlegten Empfänger.
- **Hintergrundjobs** laufen im Server-Prozess alle 15 Minuten: monatlicher Report-Versand (Tag einstellbar, Standard der 3. ab 07:00 Uhr Zürich) und Budget-Alarm an Admins und Consultants bei 80, 95 und 100 % des Forecasts. Jeder Versand wird in der Datenbank vermerkt (`job_runs`, `budget_alerts`) und geht nur einmal raus, auch wenn mehrere Instanzen laufen.
- Installierbare Handy-App (PWA): Startbildschirm-Icon, App-Hülle und letzte Daten offline, Buchungen ohne Netz werden zwischengespeichert und beim nächsten Kontakt gesendet.
- Wochenfreigabe: «Woche einreichen» im Kalender, Leads sehen unter Monatsabschluss pro Person und Woche, was eingereicht ist und wo Stunden fehlen.
- Persönliche Erinnerung «Heute noch nichts gebucht» per E-Mail, Microsoft Teams oder Slack (Incoming Webhook), Uhrzeit und Wochentage im Profil wählbar; kommt nur an Arbeitstagen ohne Buchung.
- Beleg-OCR: Beleg mit der Handykamera fotografieren, Betrag, Datum, MwSt-Satz, Kategorie und Händler werden vorgeschlagen (Texterkennung läuft im Browser, das Foto bleibt auf dem Gerät).
- Projektarten Zeit und Material, Fixpreis und Retainer (Stundenkontingent pro Monat mit Auslastung), Profitabilität pro Projekt und Kunde (Umsatz gegen Stunden × Kostensatz plus Spesen), Kunden in CHF, EUR oder USD mit täglichem EZB-Kurs (manuell übersteuerbar).
- Forecast-Szenarien im Projekt: Velocity-Band optimistisch bis pessimistisch und Was-wäre-wenn mit Velocity, Stundensatz, Umfang, Budget und Teamgrösse.
- Geplante Berichte: Wochenmail an die Projektleitung, Monatsmail an die Geschäftsführung, frei konfigurierbar (Einstellungen → Berichte & Export). Kompletter Datenexport als CSV oder JSON.
- Dashboard-Widgets Auslastung, offene Rechnungen, Ferienplan und Top-Kunden.
- Ressourcenplanung (Leitung → Planung): Personen × Wochen mit Kapazität nach Pensum, Ferien und Feiertagen gegen geplante Projektstunden, Projekte gegen Restbudget in Stunden, Engpässe werden Wochen im Voraus oben aufgelistet. Reservationen pro Person, Projekt und Woche (`PUT /api/planning`).
- Kundenportal: Leads laden auf der Kundenseite Kontaktpersonen ein (Rolle «customer», Passwort per Mail-Link). Diese sehen nur ihren Kunden: Budget, Restbudget, Prognose, Stunden pro Monat, Monatsreports als PDF/Excel und gestellte Rechnungen (`/api/portal`). Beispielkonto `portal.medtech`.

## Arbeitszeit & Absenzen

- Sollzeit pro Woche und Feiertage unter Einstellungen → Arbeitszeit; Pensum, Ferientage, Erfassungsbeginn und Überträge pro Person unter Absenzen → Team (nur Admins). Überzeit-Saldo, Ferienstand und Soll/Ist stehen als Kacheln über dem Kalender.
- Neue Benutzer starten ihr Zeitkonto am Tag der Einladung. Für bestehende Personen «Erfassung ab» und den Überzeit-Übertrag setzen, bevor der Saldo zählt.
- Interne Arbeit (Administration, Weiterbildung) bucht man auf einen Kunden ohne Stundensatz, z. B. «Intern». Sie zählt zur Arbeitszeit, aber nicht in den Kundenreport.

## Erfassen-Komfort

- **Kalender** unter Zeiterfassung: Woche mit Zeitachse. Ziehen auf eine freie Stelle öffnet das Eintrags-Fenster (Zeit oder Spese) mit genau der gezogenen Dauer (15-Minuten-Raster, Beginn- und Endzeit werden beim Ziehen angezeigt), Blöcke verschieben oder am unteren Rand verlängern ändert Beginn und Dauer, Klick bearbeitet. Jeder Kunde hat eine eigene Farbe, interne Arbeit ist grau, eine rote Linie markiert die aktuelle Uhrzeit. Buchungen ohne Uhrzeit (z. B. aus der Listenansicht oder von früher) stehen oben im Tag; die Uhrzeit wird in der Spalte `start_time` gespeichert.
- **Schnellwahl** im Eintrags-Fenster und in der Listenansicht: ein Suchfeld über Favoriten (Stern) und die Buchungen der letzten 30 Tage; Pfeiltasten und Enter übernehmen Kunde, Projekt, Subprojekt und Tätigkeit. Favoriten liegen pro Person im Browser.
- **Darstellung** Hell, Dunkel oder wie das System: Umschalter unten in der Navigation und auf der Profilseite, pro Browser gespeichert.
- **Profil** (Klick auf den eigenen Namen unten in der Navigation): Konto, Passwort ändern, Darstellung, Favoriten verwalten. Unter dem Profil steht die Version (Commit-Hash und Build-Datum).
- **Logo**: Admins laden unter Einstellungen → Erscheinungsbild ein eigenes Logo hoch (PNG, SVG, JPEG, WebP bis 1 MB, abgelegt unter `DATA_DIR/branding`); ohne Logo erscheint das Matterhorn-Zeichen in der Hauptfarbe.
- **Dropdowns** sind gestaltete Auswahlfelder (Radix Select, `web/src/ui/Select.tsx`) mit Tastaturbedienung statt Browser-Standard.
- Aufbau und alle Abhängigkeiten: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).
- **Kunden & Projekte**: durchsuchbare Kundenliste (Name, Projekt, JIRA-Schlüssel) mit Budget, Verbrauch, Auslastung, Forecast und Status, in Seiten zu 50 Kunden. Kunde anklicken öffnet die Kundenseite mit Kennzahlen und dem Projektbaum.
- **Projektseite** von der Kundenseite aus → Projekt öffnen: Kennzahlen, Subprojekte mit JIRA-Tickets und Burn-up; Budgets, Namen und JIRA-Schlüssel dort bearbeiten (Admins und Consultants).
- **Erinnerung:** montags ab 09:00 Uhr Zürich geht eine E-Mail an alle, denen in der Vorwoche mehr als zwei Stunden zur Sollzeit fehlen (Absenzen zählen mit). Ausschalten unter Einstellungen → Arbeitszeit.

## Spesen & Rechnung

- **Spesen** mit MwSt-Satz, Kategorie «Kilometer» (Betrag = km × Pauschale aus Einstellungen → Rechnung) und Beleg (JPEG/PNG/WebP/PDF bis 10 MB). Belege liegen im Dateisystem unter `DATA_DIR/receipts/` (Docker-Volume `data`), nur die Metadaten in der Datenbank.
- **Freigabe:** Spesen von Mitarbeitenden sind «offen», bis Consultants oder Admins sie unter Monatsabschluss → Offene Spesen bewilligen oder ablehnen (mit Begründung per E-Mail). Nur bewilligte, weiterverrechenbare Spesen erscheinen im Kundenreport und auf der Rechnung.
- **Rechnung** unter Reports → Kunde: Absender und IBAN einmalig unter Einstellungen → Rechnung, Rechnungsadresse pro Kunde. «Rechnung erstellen» friert Positionen (Stunden pro Subprojekt und Satz, bewilligte Spesen) und Adressen ein, vergibt die nächste Nummer `JJJJ-NNNN` und erzeugt ein PDF mit Schweizer QR-Zahlteil. Senden geht an die Report-Empfänger des Kunden. Status: Entwurf → Versendet → Bezahlt; nach dem Versand wird storniert statt gelöscht, damit die Nummern lückenlos bleiben.

## Microsoft- und Google-Anmeldung einrichten

- **Microsoft:** Im Entra Admin Center eine App registrieren, Redirect-URI `<APP_URL>/api/auth/microsoft/callback` (Typ Web), Client-Secret anlegen. `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` setzen.
- **Google:** In der Google Cloud Console einen OAuth-Client (Webanwendung) mit Redirect-URI `<APP_URL>/api/auth/google/callback` anlegen. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` setzen.

Die Buttons erscheinen auf der Anmeldeseite, sobald die Werte gesetzt sind.

## Prototyp als einzelne HTML-Datei

`npm run build:single -w web` erzeugt `web/dist-single/artifact.html`, eine Version mit Beispieldaten ohne Server.

## Rollen, Datenschutz und Arbeitsrecht

- **Rollen:** Admin und Consultant sehen alles. Mitarbeitende sehen Eigenes, ausser sie leiten ein Projekt (Projektseite → Projektleitung) oder ein Team (Einstellungen → Benutzer → Teams). Rolle «Treuhand» sieht alles und kann nichts ändern.
- **Sicherheit:** Zwei-Faktor mit Authenticator-App, Passkeys, Geräteübersicht (Profil → Sicherheit); Admins setzen den zweiten Faktor zurück.
- **Datenschutz:** Auskunft unter Profil → Meine Daten, Anonymisieren in der Benutzerliste, Fristen und Ablauf in [docs/DATENSCHUTZ.md](docs/DATENSCHUTZ.md).
- **Arbeitszeitmodell** (Einstellungen → Arbeitszeit): vereinfacht nach Art. 73b ArGV 1 oder Kommen/Gehen mit Pausen; bei Kommen/Gehen erscheint in der Zeiterfassung die Stempelleiste.
- **Lasttest:** `npm run loadtest -w server`, Ergebnisse in [docs/LASTTEST.md](docs/LASTTEST.md).

## SaaS mit Abo

Mit `SAAS=true` läuft die Installation als Abo-Dienst für viele Firmen: Pakete Start, Team und Business mit Preis pro Person (CHF 9, 15 und 22 pro Monat, mindestens 3 Personen), 30 Tage Testphase, Bezahlung per Stripe oder auf Rechnung, jede Firma unter `<kürzel>.<SAAS_BASE_DOMAIN>`, Einrichtungsassistent und Umsatzübersicht für den Betreiber. Ohne `SAAS` gibt es keine Pakete. Einrichtung: [docs/BETRIEB.md](docs/BETRIEB.md), Abschnitt 15.

## Betrieb in der Schweiz

Produktionsbetrieb auf einer Schweizer Cloud-VM (Infomaniak Public Cloud oder Exoscale) mit Docker Compose, automatischem TLS und nächtlichen Backups:

- [docs/BETRIEB.md](docs/BETRIEB.md) – Runbook: VM einrichten, Docker, DNS, erster Start, Updates, Rollback, Backups und Wiederherstellung, Überwachung, Logs, Datenstandort.
- [docs/AVV-Vorlage.md](docs/AVV-Vorlage.md) – Vorlage einer Vereinbarung zur Auftragsbearbeitung nach revDSG/DSV mit TOM-Liste und Unterauftragsbearbeitern (vor Gebrauch juristisch prüfen lassen).
- `deploy/docker-compose.prod.yml` – Stack mit `app`, `db` (MariaDB 11.4), `caddy` (Let's Encrypt) und `backup`.
- `deploy/Caddyfile` – Reverse-Proxy, Sicherheits-Header, öffentliche Statusseite unter `status.<Domain>`.
- `deploy/.env.prod.example` – Vorlage für `deploy/.env.prod` (alle Umgebungsvariablen mit Erklärung).
- `deploy/backup.sh` – nächtlicher Dump um 02:30 Uhr, 30 Tage Aufbewahrung, `latest.json` für die Statusseite, optionale Off-Site-Kopie per S3.
- `deploy/restore.sh` – Backup auflisten und mit Rückfrage wiederherstellen.
