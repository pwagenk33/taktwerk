# Taktwerk: Aufbau, Abhängigkeiten, Datenablage

Stand: Oktober 2026. Dieses Dokument erklärt, aus welchen Teilen die Anwendung besteht, welche Fremdbibliotheken sie nutzt und wozu, wo Daten liegen und wie man an sie herankommt.

## 1. Überblick

Taktwerk ist eine Web-Anwendung aus drei Teilen in einem Repository (npm-Workspaces):

| Teil | Ordner | Technik | Aufgabe |
|---|---|---|---|
| Domäne | `packages/domain` | TypeScript, ohne Framework | Datentypen, Berechnungen (Budget, Forecast, Velocity, Arbeitszeit), Beispieldaten |
| Server | `server` | Node 22, Fastify 5, Drizzle ORM, MariaDB | API, Anmeldung, Datenbank, E-Mail, PDF/Excel, Jobs |
| Web | `web` | React 18, Vite, eigenes CSS, Radix UI | Oberfläche im Browser |

Der Server liefert die fertig gebaute Web-Oberfläche gleich mit aus. Im Betrieb läuft also **ein** Prozess (`node server/dist/main.js`), der unter Port 3000 sowohl die Seite als auch die API unter `/api/...` anbietet.

Die Domäne ist bewusst getrennt: Dieselben Berechnungen laufen im Browser (Demo ohne Server, Vorschau) und auf dem Server (Reports, Rechnungen, Jobs). So gibt es keine zwei Versionen der Formeln.

```
Browser (React)  ──HTTP/JSON──▶  Fastify (server)  ──SQL──▶  MariaDB
      │                               │
      │ nutzt @taktwerk/domain        │ nutzt @taktwerk/domain
      │                               ├──SMTP──▶ Mailserver (lokal: Mailpit)
      │                               ├──Dateien──▶ DATA_DIR (Belege, Logo)
      │                               └──OAuth──▶ Microsoft / Google (optional)
```

## 2. Was läuft wo (Docker-Setup auf dem PC)

`docker compose up -d --build` startet drei Container (siehe `docker-compose.yml`):

| Container | Image | Port | Inhalt |
|---|---|---|---|
| `db` | `mariadb:11.4` | 3306 | Die Datenbank `taktwerk`, Benutzer `taktwerk` / `taktwerk` |
| `mail` | `axllent/mailpit` | 8025 (Web), 1025 (SMTP) | Fängt alle E-Mails ab, Postfach unter http://localhost:8025 |
| `app` | wird aus `Dockerfile` gebaut | 3000 | Server + Web-Oberfläche, http://localhost:3000 |

### Wo liegt die Datenbank?

Die Daten liegen **nicht** als Datei im Projektordner, sondern in einem Docker-Volume namens `reporting-tool_db` (Name des Ordners + `_db`). Docker Desktop unter Windows legt alle Volumes in seiner WSL-2-Maschine ab, physisch in der Datei `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`. Diese Datei öffnet man nicht direkt; stattdessen spricht man die Datenbank über den Container an:

```
docker compose exec db mariadb -u taktwerk -ptaktwerk taktwerk
```

Da Port 3306 nach aussen gemappt ist, geht auch jedes Datenbank-Programm (HeidiSQL, DBeaver, DataGrip) mit Host `localhost`, Port `3306`, Benutzer `taktwerk`, Passwort `taktwerk`, Datenbank `taktwerk`.

Sicherung und Wiederherstellung:

```
docker compose exec db mariadb-dump -u taktwerk -ptaktwerk taktwerk > sicherung.sql
docker compose exec -T db mariadb -u taktwerk -ptaktwerk taktwerk < sicherung.sql
```

Das Volume überlebt `docker compose down` und Neubauten der App. Es wird nur mit `docker compose down -v` gelöscht (dann sind die Daten weg).

### Wo liegen hochgeladene Dateien?

Belege von Spesen und das Logo liegen im zweiten Volume `reporting-tool_data`, im Container unter `/app/data` (`DATA_DIR`):

```
/app/data/receipts/<spesen-id>     Belegdatei (JPEG, PNG, WebP, PDF)
/app/data/branding/logo            Logo der Organisation
```

Ohne Docker (lokale Entwicklung) ist das der Ordner `./data` neben dem Server.

### Datenbank-Tabellen

Das Schema steht in `server/src/db/schema.ts`, Änderungen laufen über Migrationen in `server/drizzle/` (werden beim Start der App automatisch angewendet). Die wichtigsten Tabellen:

| Tabelle | Inhalt |
|---|---|
| `organizations` | Eine Zeile pro Firma mit allen Einstellungen als JSON (Design, Arbeitszeit, Rechnung, Feiertage) |
| `users`, `sessions`, `oauth_accounts`, `password_tokens` | Benutzer, Anmeldesitzungen, Microsoft/Google-Verknüpfungen, Einladungs- und Reset-Links |
| `customers`, `customer_rates`, `projects`, `sub_projects` | Kunden mit Stundensätzen (mit Gültigkeitsdatum), Projekte, Subprojekte mit Budget |
| `time_entries` | Zeitbuchungen (Datum, Beginn `start_time`, Dauer, Grund, verrechenbar, JIRA-Issue) |
| `expenses` | Spesen mit Status, MwSt, Kilometer, Belegverweis |
| `absences`, `work_models` | Absenzen und Arbeitszeitmodelle (Pensum, Ferien, Überträge) |
| `month_closings`, `audit_log` | Monatsabschlüsse und Änderungsprotokoll |
| `invoices`, `invoice_positions` | Rechnungen mit Nummernkreis und Positionen |
| `jira_issues` | Tickets mit Story Points (Beispieldaten; JIRA-Live-Anbindung offen) |
| `job_runs` | Welche Jobs (Monatsreport, Budgetwarnung, Stundenerinnerung) schon gelaufen sind |

## 3. Abhängigkeiten und wozu sie da sind

Alle Fremdbibliotheken sind Open Source (MIT/Apache/ISC) und kommen per `npm ci` aus dem npm-Registry. Versionen stehen in den `package.json`-Dateien und sind in `package-lock.json` festgenagelt.

### Server (`server/package.json`)

| Paket | Zweck |
|---|---|
| `fastify` | Webserver und API-Framework (Routen, Validierung, Logging) |
| `@fastify/cookie` | Sitzungs-Cookie lesen und setzen |
| `@fastify/multipart` | Datei-Uploads (Belege, Logo) |
| `@fastify/static` | Liefert die gebaute Web-Oberfläche aus |
| `drizzle-orm` | Datenbankzugriff in TypeScript (typsichere SQL-Abfragen, Migrationen) |
| `mysql2` | Treiber für MariaDB/MySQL |
| `zod` | Prüft alle Eingaben der API (Pflichtfelder, Formate, Grenzen) |
| `arctic` | Anmeldung mit Microsoft Entra ID und Google (OAuth 2.0 / OpenID Connect) |
| `nodemailer` | E-Mail-Versand über SMTP (Einladung, Passwort, Reports, Erinnerungen) |
| `pdfkit` | PDF-Erzeugung (Kundenreport, Rechnung mit QR-Rechnung) |
| `qrcode` | Swiss-QR-Code auf der Rechnung |
| `exceljs` | Excel-Export des Monatsreports |

Nur für Entwicklung und Build: `typescript`, `tsx` (TypeScript direkt ausführen), `esbuild` (Bündeln für den Betrieb), `drizzle-kit` (Migrationen erzeugen), `vitest` (Tests), `@types/*` (Typdefinitionen).

Passwörter werden mit `scrypt` aus der Node-Standardbibliothek gehasht, Sitzungen als SHA-256-Hash gespeichert; dafür braucht es keine Fremdbibliothek.

### Web (`web/package.json`)

| Paket | Zweck |
|---|---|
| `react`, `react-dom` | Oberflächen-Framework |
| `@radix-ui/react-select` | Barrierefreie, gestaltbare Dropdowns (Tastatur, Suche durch Tippen) |
| `recharts` | Diagramme (Burn-up, Velocity, Budgetbalken) |
| `react-grid-layout` | Verschiebbare Dashboard-Widgets |
| `@taktwerk/domain` | Eigene Domäne (siehe oben) |

Nur für Entwicklung und Build: `vite` (Entwicklungsserver und Bundler), `@vitejs/plugin-react`, `vite-plugin-singlefile` (Demo als eine einzige HTML-Datei), `typescript`, `@types/*`.

Die Schrift «Hanken Grotesk» und «JetBrains Mono» kommen von Google Fonts (`web/index.html`); ohne Internet fällt der Browser auf Systemschriften zurück. Für einen rein internen Betrieb können die Schriftdateien ins Repository gelegt werden.

### Domäne (`packages/domain`)

Keine Laufzeit-Abhängigkeiten. Nur `typescript` und `vitest` für Tests.

### Betrieb

| Komponente | Version | Zweck |
|---|---|---|
| Node.js | 22 | Laufzeit für Server und Build |
| MariaDB | 11.4 | Datenbank |
| Docker Desktop | aktuell | Lokaler Betrieb aller drei Container unter Windows (WSL 2) |
| Mailpit | 1.21 | Nur lokal: fängt E-Mails ab, statt sie zu versenden |

## 4. Konfiguration (`.env`)

Die Datei `.env` liegt im Projektordner, ist nicht in Git (siehe `.env.example`) und wird vom Container `app` gelesen:

| Variable | Bedeutung |
|---|---|
| `APP_URL` | Öffentliche Adresse der App, für Links in E-Mails und die OAuth-Rückleitung |
| `DATABASE_URL` | Verbindung zur Datenbank (im Docker-Setup wird sie von `docker-compose.yml` überschrieben) |
| `SESSION_DAYS` | Wie lange eine Anmeldung gilt |
| `SMTP_*` | Mailserver; ohne `SMTP_HOST` landen Mails nur im Log (Docker: Mailpit) |
| `MICROSOFT_*`, `GOOGLE_*` | Zugangsdaten der App-Registrierung für die Anmeldung mit Firmenkonto; leer = Anbieter ausgeblendet |
| `DATA_DIR` | Ablage für Belege und Logo |

## 5. Vom Quelltext zum laufenden Programm

1. `npm ci` lädt alle Abhängigkeiten gemäss `package-lock.json`.
2. `npm run build -w web`: TypeScript prüfen, Vite bündelt React-App und CSS nach `web/dist/` (mit Commit-Hash und Datum als Versionsstempel).
3. `npm run build -w server`: esbuild bündelt den Server nach `server/dist/`.
4. Start: `node server/dist/main.js` wendet offene Migrationen an, startet die Jobs (alle 15 Minuten: Monatsreport, Budgetwarnungen, Stundenerinnerung) und lauscht auf Port 3000.

Das `Dockerfile` macht genau diese Schritte in zwei Stufen (Build-Stufe mit allen Werkzeugen, Laufzeit-Stufe nur mit dem Nötigen).

Befehle für Entwicklung: `npm run dev:server` (Server mit Neustart bei Änderungen), `npm run dev:web` (Vite mit Live-Reload, leitet `/api` an den Server weiter), `npm test` (65 Tests: Domäne und API gegen eine Test-Datenbank), `npm run typecheck`.

## 6. Ist React + CSS zeitgemäss?

Ja. React ist nach wie vor das meistgenutzte Oberflächen-Framework; Next.js (etwa bei kubabonus.com) ist ein Aufsatz auf React. Für eine Anwendung hinter einer Anmeldung bringt Next.js (Server-Rendering, SEO) keinen Vorteil, dafür mehr Betriebsaufwand.

Beim Styling setzt Taktwerk auf eigenes CSS mit Design-Tokens (Farben, Abstände, Schrift als CSS-Variablen), damit Hauptfarbe, Logo und Hell/Dunkel ohne Umbau konfigurierbar bleiben. Für Bedienelemente, die der Browser schlecht gestaltbar macht (Dropdowns, später Dialoge, Tooltips, Datumswahl), kommen Radix-UI-Primitives dazu: unsichtbar in der Logik, barrierefrei, komplett in unserem Design. Das ist derselbe Weg, den moderne Komponenten-Bibliotheken wie shadcn/ui gehen. Ein Wechsel auf Tailwind oder eine fertige Komponenten-Bibliothek ist möglich, aber kein Gewinn an Funktion, sondern nur an Geschmack; er würde bestehende Seiten neu schreiben.
