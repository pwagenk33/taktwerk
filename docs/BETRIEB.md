# Betrieb in der Schweiz – Runbook

Diese Anleitung beschreibt Schritt für Schritt, wie TrackInsight auf einer eigenen Cloud-VM in der Schweiz betrieben wird. Alle Dateien dazu liegen im Ordner `deploy/`:

| Datei | Zweck |
|---|---|
| `deploy/docker-compose.prod.yml` | Produktions-Stack: App, Datenbank, Caddy (TLS), Backup |
| `deploy/Caddyfile` | Reverse-Proxy und automatische Zertifikate |
| `deploy/.env.prod.example` | Vorlage für die Konfiguration (`deploy/.env.prod`) |
| `deploy/backup.sh` | Nächtliches Datenbank-Backup |
| `deploy/restore.sh` | Backup wiederherstellen |

Jeder Befehl steht in einem eigenen Block. Befehle werden auf der VM im Terminal eingegeben (nach dem Login per SSH), eine Zeile nach der anderen, jeweils mit Enter bestätigen.

---

## 1. Anbieter und Grösse der VM

Beide Anbieter betreiben ihre Rechenzentren in der Schweiz, die Daten bleiben in der Schweiz:

- **Infomaniak Public Cloud** (Genf) – Empfehlung für den Einstieg: einfache Oberfläche, Rechnung in CHF, Support auf Deutsch, Swiss Backup als Off-Site-Speicher im gleichen Konto.
- **Exoscale** (Genf oder Zürich) – ebenfalls sehr gut, etwas technischer, mit Objektspeicher SOS für Off-Site-Backups.

**Empfohlene Grösse für bis ca. 50 Mitarbeitende:** 2 vCPU, 4 GB RAM, 40–50 GB SSD, Ubuntu 24.04 LTS. Das kostet bei beiden Anbietern rund 15–25 CHF pro Monat. Bei mehr Personen oder vielen Belegen (Fotos) zuerst den Speicher vergrössern.

Beim Erstellen der VM:

1. Betriebssystem **Ubuntu 24.04 LTS** wählen.
2. Den eigenen **SSH-Schlüssel** hinterlegen (kein Passwort-Login).
3. Eine **feste öffentliche IP-Adresse** zuweisen (Infomaniak: «Floating IP», Exoscale: Standard-IP ist fest).
4. Firewall / Security Group: nur die Ports **22 (SSH), 80 (HTTP) und 443 (HTTPS)** öffnen. Port 3306 (Datenbank) bleibt zu.

## 2. DNS einrichten

Beim Domain-Anbieter (z. B. Infomaniak, Hostpoint, Switch) zwei Einträge setzen. `<IP>` ist die feste IP der VM:

| Typ | Name | Wert |
|---|---|---|
| A | `zeit.firma.ch` | `<IP>` |
| A | `status.zeit.firma.ch` | `<IP>` |

Der zweite Eintrag ist für die öffentliche Statusseite. Warten, bis die Einträge aktiv sind (meist wenige Minuten, maximal ein paar Stunden). Prüfen vom eigenen Rechner aus:

```bash
nslookup zeit.firma.ch
```

## 3. Auf der VM anmelden und System aktualisieren

Vom eigenen Rechner aus (Benutzername ist bei Ubuntu-Images meist `ubuntu`, bei Infomaniak `debian` oder `ubuntu`, siehe Anbieter):

```bash
ssh ubuntu@<IP>
```

System aktualisieren:

```bash
sudo apt update && sudo apt upgrade -y
```

Zeitzone setzen (wichtig für die Backup-Uhrzeit und die Logs):

```bash
sudo timedatectl set-timezone Europe/Zurich
```

Automatische Sicherheitsupdates für Ubuntu einschalten:

```bash
sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades
```

## 4. Docker installieren

Offizielles Installationsskript von Docker (installiert Docker Engine und Docker Compose):

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Den eigenen Benutzer berechtigen, damit `docker` ohne `sudo` geht:

```bash
sudo usermod -aG docker $USER
```

Danach **einmal ab- und wieder anmelden** (`exit`, dann erneut `ssh ...`). Prüfen:

```bash
docker compose version
```

## 5. Projekt herunterladen

Git ist auf Ubuntu meist schon da, sonst:

```bash
sudo apt install -y git
```

Repository klonen (Adresse durch die eigene ersetzen; bei einem privaten Repository einen Deploy-Key oder ein Zugriffstoken verwenden):

```bash
git clone https://github.com/<konto>/taktwerk.git ~/trackinsight
```

In den Ordner wechseln – **alle weiteren Befehle werden in diesem Ordner ausgeführt**:

```bash
cd ~/trackinsight
```

## 6. Konfiguration ausfüllen

Vorlage kopieren:

```bash
cp deploy/.env.prod.example deploy/.env.prod
```

Drei sichere Passwörter erzeugen (den Befehl dreimal ausführen, jede Ausgabe kopieren):

```bash
openssl rand -base64 32
```

Datei bearbeiten (`nano`: speichern mit Ctrl+O, Enter; beenden mit Ctrl+X):

```bash
nano deploy/.env.prod
```

Mindestens diese Werte setzen:

- `APP_DOMAIN` – die Domain aus Schritt 2, z. B. `zeit.firma.ch`
- `APP_URL` – `https://` + dieselbe Domain
- `MARIADB_ROOT_PASSWORD` – Passwort 1
- `MARIADB_PASSWORD` – Passwort 2
- `DATABASE_URL` – **dasselbe Passwort 2** an der Stelle `BITTE-AENDERN-db` einsetzen
- `SMTP_*` – Zugangsdaten des Mailkontos, von dem die App E-Mails verschickt (Einladungen, Erinnerungen, Reports)

Dateirechte einschränken, damit nur der eigene Benutzer die Passwörter lesen kann:

```bash
chmod 600 deploy/.env.prod
```

**Wichtig:** `deploy/.env.prod` enthält alle Passwörter. Sie darf nie ins Git, nie per E-Mail verschickt und nicht in Chats eingefügt werden. Eine Kopie gehört in den Passwort-Manager der Firma.

## 7. Erster Start

Bauen und starten (der erste Durchlauf dauert einige Minuten):

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Status prüfen – alle vier Dienste sollen `running` bzw. `healthy` sein:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
```

Caddy holt beim ersten Aufruf automatisch ein Zertifikat von Let's Encrypt. Das klappt nur, wenn DNS (Schritt 2) stimmt und die Ports 80/443 offen sind. Prüfen:

```bash
curl -I https://zeit.firma.ch/api/health
```

Erwartet: `HTTP/2 200`. Falls nicht, Caddy-Log anschauen:

```bash
docker compose -f deploy/docker-compose.prod.yml logs --tail 100 caddy
```

Die Zertifikate werden von Caddy **automatisch erneuert** (alle ca. 60 Tage), es ist nichts weiter zu tun.

## 8. Erste Firma anlegen

Die erste Organisation und der erste Admin werden per Kommandozeile erstellt – siehe README, Abschnitt «Erste Firma anlegen». In der Produktionsumgebung lautet der Befehl (Werte anpassen):

```bash
docker compose -f deploy/docker-compose.prod.yml run --rm app node server/dist/cli.js init "Firma AG" "Vorname Nachname" admin@firma.ch admin
```

Der Einladungslink wird ausgegeben und per E-Mail verschickt. Damit wird das Passwort gesetzt. **Keine Beispieldaten (`seed`) in der Produktion laden.**

Danach in der App als Admin: Einstellungen → Arbeitszeit, Rechnung, Erscheinungsbild ausfüllen, Mitarbeitende einladen.

## 9. Updates einspielen

Wenn eine neue Version im Git liegt. Vorher den Stand merken, damit ein Rollback möglich ist:

```bash
git describe --tags --always
```

Neue Version holen:

```bash
git pull
```

Neu bauen und starten (die App ist dabei ca. 30–60 Sekunden nicht erreichbar; Datenbank-Migrationen laufen beim Start automatisch):

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Prüfen:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
```

Alte Docker-Images aufräumen (spart Speicherplatz):

```bash
docker image prune -f
```

Empfehlung: Updates am Abend oder am Wochenende einspielen und vorher ein Backup auslösen (Abschnitt 11).

## 10. Rollback (zurück zur vorherigen Version)

Falls ein Update Probleme macht. Da Migrationen die Datenbank verändern, wird **sowohl der Code als auch die Datenbank** zurückgesetzt.

Schritt 1 – zur vorherigen Version wechseln (`<tag>` ist der Stand aus Schritt 9, z. B. `v1.4.0`):

```bash
git checkout <tag>
```

Schritt 2 – Backup vom Vortag (vor dem Update) wiederherstellen. Ohne Argument zeigt das Skript die Liste; dann die Datei vom Tag vor dem Update wählen:

```bash
bash deploy/restore.sh
```

```bash
bash deploy/restore.sh trackinsight-2026-10-18.sql.gz
```

Das Skript stoppt die App, spielt den Dump ein und startet die App wieder.

Schritt 3 – mit dem alten Code neu bauen:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

Buchungen, die zwischen dem Backup und dem Rollback gemacht wurden, gehen dabei verloren – die Mitarbeitenden informieren.

Später wieder zur aktuellen Version:

```bash
git checkout main
```

## 11. Backups

**Was passiert automatisch:** Der Dienst `backup` erstellt jede Nacht um 02:30 Uhr (Zürich) einen Dump der Datenbank (`mariadb-dump --single-transaction`, also ohne die App anzuhalten) und speichert ihn komprimiert im Docker-Volume `trackinsight_backups` als `trackinsight-JJJJ-MM-TT.sql.gz`. Die letzten **30 Tage** bleiben erhalten, ältere werden gelöscht. Zusätzlich wird `latest.json` geschrieben; die App zeigt daraus auf der Statusseite, wann das letzte Backup fertig war.

Backups anzeigen:

```bash
bash deploy/restore.sh
```

Sofort ein Backup auslösen (z. B. vor einem Update):

```bash
docker compose -f deploy/docker-compose.prod.yml exec backup bash /backup.sh einmal
```

**Wiederherstellungs-Test:** Jeden Sonntag nach dem Backup spielt der Dienst den Dump in eine Wegwerf-Datenbank im eigenen Container ein (die Live-Datenbank bleibt unberührt) und vergleicht Tabellen und Zeilen (Buchungen, Personen, Firmen) mit der Live-Datenbank. Das Ergebnis steht in `verify.json` und auf der Statusseite als «Wiederherstellung geprüft»; älter als 9 Tage oder fehlgeschlagen erscheint rot. Den Wochentag ändert `BACKUP_VERIFY_WEEKDAY` (1 = Montag … 7 = Sonntag). Sofort prüfen:

```bash
docker compose -f deploy/docker-compose.prod.yml exec backup bash /backup.sh pruefen
```

Backup-Log anschauen:

```bash
docker compose -f deploy/docker-compose.prod.yml logs --tail 50 backup
```

**Nicht von der Datenbank-Sicherung erfasst** sind die hochgeladenen Belege und das Logo im Volume `trackinsight_data`. Diese Dateien einmal pro Woche auf den eigenen Rechner kopieren (vom eigenen Rechner aus ausführen):

```bash
ssh ubuntu@<IP> 'docker run --rm -v trackinsight_data:/data alpine tar cz -C /data .' > belege-$(date +%F).tar.gz
```

**Off-Site-Kopie (empfohlen):** Eine VM kann ausfallen oder versehentlich gelöscht werden. Darum die Backups zusätzlich in einen Objektspeicher in der Schweiz kopieren: Infomaniak **Swiss Backup** (S3-kompatibel) oder Exoscale **SOS** (Region `ch-gva-2` oder `ch-dk-2`). Dazu in `deploy/.env.prod` die Werte `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` (und bei Exoscale `BACKUP_S3_REGION`) setzen, dann den Backup-Dienst neu starten:

```bash
docker compose -f deploy/docker-compose.prod.yml up -d backup
```

Das Skript lädt dann nach jedem Dump die Datei und `latest.json` mit `rclone` in den Bucket und löscht dort ebenfalls Dumps, die älter als 30 Tage sind. Den Bucket beim Anbieter mit **Versionierung** oder **Object Lock** anlegen, damit ein Angreifer mit den Zugangsdaten die Backups nicht löschen kann.

**Wiederherstellung vierteljährlich testen.** Ein Backup, das nie getestet wurde, ist keines. Einfachste Variante ohne Risiko für die Produktion – auf dem eigenen Rechner (mit Docker) das Backup in die lokale Entwicklungsumgebung laden:

Backup von der VM holen (vom eigenen Rechner aus):

```bash
ssh ubuntu@<IP> 'docker compose -f ~/trackinsight/deploy/docker-compose.prod.yml exec -T backup cat /backups/latest.json'
```

```bash
ssh ubuntu@<IP> 'docker compose -f ~/trackinsight/deploy/docker-compose.prod.yml exec -T backup cat /backups/trackinsight-2026-10-18.sql.gz' > test-restore.sql.gz
```

Lokal in die Entwicklungs-Datenbank einspielen (im Projektordner, lokale `docker compose up -d` läuft):

```bash
gunzip -c test-restore.sql.gz | docker compose exec -T db mariadb -utaktwerk -ptaktwerk taktwerk
```

Dann `http://localhost:3000` öffnen, sich mit einem echten Konto anmelden und prüfen, ob Buchungen und Kunden da sind. Datum und Ergebnis des Tests kurz notieren (z. B. im Firmen-Wiki). Danach die lokale Datenbank wieder leeren, da sie echte Personendaten enthält:

```bash
docker compose down -v
```

## 12. Überwachung

- **Healthcheck:** Docker prüft alle 30 Sekunden `GET /api/health` der App und startet sie bei Fehlern neu (`restart: unless-stopped`). Zustand sehen mit `docker compose -f deploy/docker-compose.prod.yml ps`.
- **Öffentliche Statusseite:** `https://status.zeit.firma.ch/status` zeigt ohne Anmeldung, ob App und Datenbank laufen und wann das letzte Backup fertig war. Die Seite ist auch unter `https://zeit.firma.ch/status` erreichbar.
- **Externe Verfügbarkeitsprüfung:** Ein kostenloser Uptime-Dienst (z. B. UptimeRobot, Better Stack, Hetrix) prüft von aussen alle 5 Minuten `https://zeit.firma.ch/api/health` (erwartet HTTP 200) und schickt bei Ausfall eine E-Mail oder SMS. Das ist die wichtigste Alarmierung, denn wenn die ganze VM weg ist, kann sie selbst nichts mehr melden.
- **Mail-Alarme:** Beim Uptime-Dienst die Admin-Adresse und eine Stellvertretung eintragen. Beim Cloud-Anbieter zusätzlich die Benachrichtigung bei hoher CPU-Last / vollem Speicher aktivieren.
- **Speicherplatz** monatlich prüfen:

```bash
df -h /
```

```bash
docker system df
```

## 13. Logs anschauen

Alle Dienste, die letzten 100 Zeilen:

```bash
docker compose -f deploy/docker-compose.prod.yml logs --tail 100
```

Nur die App, live mitlesen (beenden mit Ctrl+C):

```bash
docker compose -f deploy/docker-compose.prod.yml logs -f app
```

Nur Fehler der App aus den letzten 24 Stunden:

```bash
docker compose -f deploy/docker-compose.prod.yml logs --since 24h app | grep -i '"level":50\|error'
```

Die Logs sind auf 5 Dateien à 20 MB pro Dienst begrenzt und füllen die Platte nicht.

## 14. Datenstandort Schweiz

- **VM und Datenbank:** Infomaniak (Genf) und Exoscale (Genf/Zürich) betreiben ausschliesslich Rechenzentren in der Schweiz. Alle Personendaten (Mitarbeitende, Arbeitszeiten, Absenzen, Belege, Kundendaten) liegen auf der VM und verlassen die Schweiz nicht.
- **Backups:** liegen auf derselben VM und – wenn eingeschaltet – im Schweizer Objektspeicher desselben Anbieters.
- **Zertifikate (Let's Encrypt, USA):** Let's Encrypt erfährt nur den Domainnamen (`zeit.firma.ch`), keine Inhalte und keine Personendaten. Die Domain wird zudem öffentlich in Zertifikats-Logs eingetragen; das ist Standard für jede HTTPS-Website.
- **E-Mail:** Der SMTP-Anbieter sieht Empfängeradressen und Mailinhalte (z. B. Einladungen, Erinnerungen, Reports als Anhang). Daher einen Schweizer Mailanbieter (z. B. Infomaniak) verwenden.
- **Microsoft-/Google-Anmeldung (optional):** Wenn eingeschaltet, erhält Microsoft bzw. Google beim Login Name und E-Mail der Person; die App selbst überträgt keine weiteren Daten dorthin.
- **Auftragsbearbeitung:** Mit jeder Kundenfirma, deren Mitarbeitende in der App erfasst werden, gehört eine Vereinbarung zur Auftragsbearbeitung abgeschlossen – Vorlage in [docs/AVV-Vorlage.md](AVV-Vorlage.md). Mit dem Cloud-Anbieter und dem Mailanbieter bestehen entsprechende Verträge (Unterauftragsbearbeiter), die bei den Anbietern abrufbar sind.

### Firma entfernen

Wenn eine Firma die Installation verlässt und alle Aufbewahrungsfristen abgelaufen sind (siehe [docs/DATENSCHUTZ.md](DATENSCHUTZ.md)):

1. Unter Einstellungen → Betreiber die Firma **deaktivieren** (niemand kann sich mehr anmelden).
2. Auf Wunsch der Firma alle Daten exportieren (Berichte & Export, als Admin der Firma).
3. Auf der VM:

```bash
docker compose -f deploy/docker-compose.prod.yml run --rm app node server/dist/cli.js org-remove <slug> LOESCHEN
```

Das löscht die Firma mit allen Personen, Buchungen, Rechnungen und Protokollen. Belege unter `data/receipts` gehören zu Spesen-IDs und werden mit dem nächsten Backup-Lauf nicht mehr gebraucht; Backups der letzten 30 Tage enthalten die Daten noch.

## 15. SaaS-Betrieb mit Abo

Für den Verkauf als Abo an viele Firmen. Selbst gehostete Installationen überspringen diesen Abschnitt.

1. **DNS:** zusätzlich zu `trackinsight.ch` einen Wildcard-Eintrag `*.trackinsight.ch` (A-Record) auf die IP der VM. Jede Firma ist danach unter `<kürzel>.trackinsight.ch` erreichbar; Caddy holt das Zertifikat beim ersten Aufruf, aber nur für Adressen, die die App kennt.
2. **`deploy/.env.prod`:** `APP_DOMAIN=app.trackinsight.ch`, `APP_URL=https://app.trackinsight.ch`, `SAAS=true`, `SAAS_BASE_DOMAIN=trackinsight.ch`, `REGISTRATION_OPEN=true`, `OPERATOR_EMAIL=…`. Die App läuft so auf `app.trackinsight.ch`, die Website auf `trackinsight.ch` (siehe unten). Die Redirect-URIs für Microsoft und Google zeigen dann ebenfalls auf `https://app.trackinsight.ch/…`.
3. **Bezahlung:**
   - *Ohne Stripe* (Start): Firmen wählen ein Paket, es ist sofort aktiv, und an `OPERATOR_EMAIL` geht «Rechnung stellen». Bei jeder Verlängerung kommt die Meldung wieder. Bleibt eine Rechnung offen, unter Einstellungen → Betreiber den Status anpassen.
   - *Mit Stripe:* in Stripe drei Produkte mit je einem Monats- und Jahrespreis **pro Person** anlegen (Start 9/90, Team 15/150, Business 22/220 Franken), die Preis-IDs in `STRIPE_PRICES` eintragen, den Webhook auf `https://app.trackinsight.ch/api/billing/webhook` einrichten (Ereignisse siehe `.env.prod.example`) und `STRIPE_SECRET_KEY` und `STRIPE_WEBHOOK_SECRET` setzen. Firmen zahlen dann per Karte, Quittungen und Kartenwechsel laufen über das Stripe-Kundenportal.
4. `docker compose -f deploy/docker-compose.prod.yml up -d` (Caddy liest das neue Caddyfile).

**Ablauf für eine Firma:** Registrierung unter `/registrieren` (ein Paket vorwählbar mit `?paket=start|team|business`) → 30 Tage Testphase → Erinnerung 7 Tage und 1 Tag vor Ende → nach dem Ende noch 7 Tage Schonfrist → danach nur lesend, bis ein Paket gewählt ist. Daten werden nie automatisch gelöscht.

**Preis pro Person:** Start CHF 9, Team CHF 15, Business CHF 22 pro aktive Person und Monat, mindestens 3 Personen, jährlich 10 Monatspreise (Kundenportal und Treuhand zählen nicht, die Preise stehen in `packages/domain/src/plans.ts`). Neue Personen sind nie blockiert: Bei Kartenzahlung passt TrackInsight die Menge im Stripe-Abo sofort an (anteilig verrechnet), bei Rechnung zählt die Zahl bei der Verlängerung. Ressourcenplanung, Kundenportal und Forecast ab Team; Treuhand-Zugang und eigene Domain ab Business. Bestehende Firmen beim Umstellen auf `SAAS=true` starten mit Business, Status aktiv.

**Eigene Domain (Business):** Die Firma trägt sie unter Einstellungen → Abo ein und setzt bei ihrem Domain-Anbieter einen CNAME auf `<kürzel>.trackinsight.ch`.

**Website:** Die öffentliche Website (Ordner `website/`, gebaut nach `website/dist`) liefert derselbe Container aus, sobald `SAAS_BASE_DOMAIN` gesetzt ist und `APP_URL` auf einer anderen Adresse läuft. `trackinsight.ch` zeigt dann Startseite, Funktionen, Preise, Sicherheit, Kontakt, Impressum, Datenschutz, AGB und AVV; `www.trackinsight.ch` leitet dorthin um. Die Preise kommen aus `packages/domain/src/plans.ts`, App und Website zeigen also immer dieselben Pakete. Das Kontaktformular schickt an `OPERATOR_EMAIL` (höchstens 5 Anfragen pro Stunde und Adresse). Texte ändern: Dateien in `website/src/pages` bearbeiten, dann wie gewohnt neu bauen. Vorschau ohne Server: `npm run build -w website -- --preview --out=/tmp/site` und `index.html` öffnen. Platzhalter in eckigen Klammern (Firma, Adresse, UID) sind gelb markiert und müssen vor dem Start ersetzt werden; AGB und Datenschutzerklärung vorher rechtlich prüfen lassen.

**Suchmaschinen:** Jede Seite hat Titel, Beschreibung, eine kanonische Adresse und Vorschaubild für LinkedIn und Co. Die Startseite beschreibt das Produkt mit Preisen und die FAQ zusätzlich als strukturierte Daten. `trackinsight.ch/sitemap.xml` listet alle Seiten (ohne 404 und AVV-Vorlage), `robots.txt` verweist darauf. Nach dem Start die Domain in der Google Search Console und in Bing Webmaster Tools bestätigen und dort die Sitemap einreichen. Lokal zeigt `http://website.localhost:3000/sitemap.xml` dieselbe Liste.

## 16. Jira Cloud verbinden

Firmen verbinden ihre Jira-Cloud-Site unter **Einstellungen → Jira** mit einem Klick. Dafür braucht die Installation einmalig eine App bei Atlassian (kostenlos):

1. Auf [developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/) mit einem Atlassian-Konto anmelden, **Create → OAuth 2.0 integration**, Name «TrackInsight».
2. **Permissions → Jira API → Add**, danach **Configure** und unter den klassischen Berechtigungen `read:jira-work` und `write:jira-work` hinzufügen (Schreiben braucht es nur für Worklogs).
3. **Authorization → OAuth 2.0 (3LO) → Add**, Callback-URL `https://app.trackinsight.ch/api/jira/callback` (lokal: `http://localhost:3000/api/jira/callback`). Es zählt genau die Adresse aus `APP_URL`.
4. **Settings**: Client ID und Secret kopieren und in `.env` (lokal) bzw. `deploy/.env.prod` als `ATLASSIAN_CLIENT_ID` und `ATLASSIAN_CLIENT_SECRET` eintragen, dann `docker compose up -d`.
5. **Distribution**: Solange die App «Not sharing» ist, kann nur ihr Besitzer sie benutzen. Für Kundenfirmen auf **Sharing** stellen; Atlassian fragt dabei nach Anbieter, Link zur Datenschutzerklärung und ob Personendaten gespeichert werden (TrackInsight übernimmt aus Jira keine Personendaten, nur Issue-Schlüssel, Titel, Status und Story Points; mit eingeschalteten Worklogs schreibt es Name, Datum, Dauer und Buchungstext der Person nach Jira).

Zum Testen gibt es Jira Cloud bis 10 Personen gratis: [atlassian.com/software/jira/free](https://www.atlassian.com/software/jira/free).

**Was beim Verbinden passiert:** TrackInsight findet die Felder «Story Points» bzw. «Story point estimate», listet die Jira-Projekte, und der Admin wählt pro Jira-Projekt ein bestehendes Projekt oder legt ein neues bei einem Kunden an. Beim Abgleich werden Epics zu Subprojekten (verknüpft über den Epic-Schlüssel), Issues ohne Epic landen im Subprojekt «Ohne Epic», Sub-Tasks werden übersprungen. Der Abgleich läuft alle 15 Minuten und auf Knopfdruck; in Jira gelöschte Issues verschwinden auch in TrackInsight. Nach dem Trennen bleiben die geladenen Issues erhalten. Das Paket Start enthält Jira nicht (Forecast ab Team).

**Worklogs nach Jira:** Unter Einstellungen → Jira → «Zeiten als Worklog nach Jira» schaltet ein Admin das Zurückschreiben ab einem Datum ein. Jede Buchung mit einem Issue-Schlüssel aus einem verknüpften Jira-Projekt wird beim Abgleich zum Worklog am Issue (Start = Kalenderzeit der Buchung oder 09:00 Schweizer Zeit, Dauer, Text «Name: Buchungstext (TrackInsight)»). Geänderte Buchungen ändern den Worklog, gelöschte löschen ihn; die Restschätzung in Jira bleibt unverändert. Pro Abgleich gehen höchstens 300 Änderungen raus, der Rest folgt 15 Minuten später. Die Worklogs stehen in Jira unter dem Atlassian-Konto, das TrackInsight verbunden hat; dieses Konto braucht im Jira-Projekt die Berechtigung «Work on issues». Verbindungen von vor dieser Version haben nur Leserechte; TrackInsight zeigt dann «Neu verbinden». Ausschalten lässt die bereits geschriebenen Worklogs in Jira stehen.

Für den Eintrag im Atlassian Marketplace siehe [MARKETPLACE.md](MARKETPLACE.md).

## 17. Kalender (Outlook und Google) als Buchungsvorschläge

Jede Person kann im Profil ihren Outlook- oder Google-Kalender verbinden. Danach erscheinen ihre Termine in der Zeiterfassung gestrichelt als Vorschläge. Ein Klick bucht einen Termin mit Zeit, Dauer und Titel. Das Subprojekt schlägt TrackInsight aus früheren Buchungen mit gleichem Text vor oder aus Kunden- und Projektnamen im Titel. TrackInsight liest nur und speichert keine Termine. Die Termine der sichtbaren Woche werden jeweils direkt geholt. Ganztägige, abgesagte, abgelehnte und als «frei» markierte Termine fallen weg.

Es werden dieselben App-Registrierungen verwendet wie für die Anmeldung mit Microsoft und Google (`MICROSOFT_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`). Bei beiden kommt je eine zusätzliche Weiterleitungsadresse dazu:

- **Microsoft Entra ID:** Unter App-Registrierung → Authentifizierung die Umleitungs-URI `https://app.trackinsight.ch/api/calendar/microsoft/callback` hinzufügen. Unter API-Berechtigungen die delegierte Berechtigung `Calendars.Read` (Microsoft Graph) hinzufügen. Je nach Einstellung der Kundenfirma muss deren IT-Admin einmal zustimmen.
- **Google Cloud:** In der OAuth-Client-ID die Weiterleitungs-URI `https://app.trackinsight.ch/api/calendar/google/callback` eintragen und die Google Calendar API aktivieren. Unter OAuth-Zustimmungsbildschirm → Bereiche `.../auth/calendar.events.readonly` hinzufügen. Dieser Bereich gilt bei Google als «sensibel»: Solange die App nicht von Google bestätigt ist, sehen Nutzer eine Warnung, und es sind höchstens 100 Testnutzer möglich. Vor dem öffentlichen Start die Bestätigung bei Google beantragen.

Lokal gilt dasselbe mit `http://localhost:3000/...`. Ohne Microsoft- bzw. Google-Konfiguration wird die jeweilige Kalenderoption nicht angezeigt.

## 18. bexio und Lohnexport

**bexio:** Firmen übertragen Rechnungen aus TrackInsight als Entwurf nach bexio (Reports → Rechnungen → «An bexio»). Dabei entsteht der Kunde als Kontakt, falls es ihn in bexio noch nicht gibt (gesucht wird nach dem Namen). Die Positionen kommen mit Nettopreisen und dem aktiven Umsatzsteuersatz, der zum Satz der Rechnung passt. Kontrollieren, verbuchen und versenden geschieht danach in bexio. Für die Verbindung braucht die Installation einmalig eine App bei bexio:

1. Auf [developer.bexio.com](https://developer.bexio.com) anmelden und eine App anlegen.
2. Als Redirect-URL `https://app.trackinsight.ch/api/bexio/callback` eintragen (lokal: `http://localhost:3000/api/bexio/callback`).
3. Die Scopes `openid`, `email`, `offline_access`, `contact_edit` und `kb_invoice_edit` freigeben.
4. Client ID und Secret als `BEXIO_CLIENT_ID` und `BEXIO_CLIENT_SECRET` in `.env` bzw. `deploy/.env.prod` eintragen und danach `docker compose up -d` ausführen.

Danach verbindet ein Admin unter Einstellungen → Rechnung → bexio. TrackInsight handelt mit den Rechten des bexio-Benutzers, der die Verbindung hergestellt hat. Persönliche Zugangstoken (PAT) sind laut bexio nur für den Eigengebrauch gedacht, deshalb läuft die Verbindung über OAuth. **Stand:** Die Anbindung ist gegen die öffentliche bexio-Dokumentation gebaut und automatisch getestet, aber noch nicht gegen ein echtes bexio-Konto. Vor dem Einsatz bei Kunden einmal mit einem bexio-Testkonto durchspielen.

**Lohnexport:** Unter Monatsabschluss → Lohnexport lädt ein Admin pro Monat eine CSV-Datei herunter. Sie enthält pro Person die geleisteten Stunden, das Soll, die Überzeit im Monat, den Überzeit-Saldo, die Absenztage nach Art (nur bewilligte) sowie Spesen und Kilometer zur Rückerstattung (nur bewilligte). Die Spalten heissen personalnummer, name, periode, lohnart, bezeichnung, menge, einheit und betrag. Die Nummern der Lohnarten stellt man unter «Lohnarten» auf das eigene Lohnprogramm ein, die Personalnummer im Arbeitsmodell der Person. Die Datei ist ein Import für Lohnprogramme und keine zertifizierte Swissdec-Übermittlung (ELM). Löhne, Sozialversicherungen und Lohnausweis rechnet weiterhin das Lohnprogramm.

## 19. Firmen-Login (SAML) und SCIM mit Microsoft Entra ID

Pro Firma unter Einstellungen → Firmen-Login (SSO), nur für Admins. Im SaaS-Betrieb ab Paket Business.

**SAML einrichten (Entra ID):**
1. Entra Admin Center → Unternehmensanwendungen → Neue Anwendung → Eigene Anwendung erstellen (nicht im Katalog).
2. Einmaliges Anmelden → SAML. Bezeichner (Entity ID) und Antwort-URL (ACS) aus TrackInsight kopieren.
3. Unter «SAML-Zertifikate» das Zertifikat (Base64) herunterladen und den Inhalt in TrackInsight einfügen, dazu die «Anmelde-URL» und optional den «Microsoft Entra-Bezeichner».
4. Benutzer und Gruppen der Anwendung zuweisen.
5. In TrackInsight die E-Mail-Domains eintragen (z. B. firma.ch) und den Firmen-Login einschalten.

Neue Personen aus diesen Domains werden beim ersten Login als Mitarbeitende angelegt. «Nur noch Firmen-Login erlauben» sperrt die Passwort-Anmeldung für alle ausser Admins (Notzugang, falls Entra ausfällt). Die Anmeldeseite zeigt «Mit Firmen-Login anmelden»; die Firma wird über die E-Mail-Domain gefunden. Eine Domain kann nur bei einer Firma eingetragen sein.

Geprüft wird die Signatur der Assertion mit dem hinterlegten Zertifikat, die Zielgruppe (Entity ID), die Gültigkeitsdauer (2 Minuten Toleranz) und dass eine Assertion nicht zweimal verwendet wird. Läuft das Entra-Zertifikat ab, das neue Zertifikat in TrackInsight einfügen.

**SCIM einrichten (Benutzer automatisch abgleichen):**
1. In TrackInsight «Token erstellen» klicken und das Token sofort kopieren (wird nur einmal angezeigt).
2. In derselben Entra-Anwendung → Bereitstellung → Automatisch. Mandanten-URL `https://<firma-adresse>/scim/v2`, geheimes Token einfügen, «Verbindung testen».
3. Zuordnungen: userName = userPrincipalName, emails[type eq "work"].value = mail, displayName, name.givenName, name.familyName, active. Gruppen werden nicht übernommen.

Entra legt Personen an, ändert Name und Adresse und deaktiviert Austritte. Löschen in Entra deaktiviert nur; Buchungen bleiben für Reports. Rollen und Teams werden in TrackInsight vergeben. Die letzte aktive Admin-Person kann per SCIM nicht deaktiviert werden.

## 20. Kurzreferenz

| Aufgabe | Befehl (im Ordner `~/trackinsight`) |
|---|---|
| Status | `docker compose -f deploy/docker-compose.prod.yml ps` |
| Starten | `docker compose -f deploy/docker-compose.prod.yml up -d` |
| Stoppen | `docker compose -f deploy/docker-compose.prod.yml down` |
| Update | `git pull && docker compose -f deploy/docker-compose.prod.yml up -d --build` |
| Logs | `docker compose -f deploy/docker-compose.prod.yml logs -f app` |
| Backup jetzt | `docker compose -f deploy/docker-compose.prod.yml exec backup bash /backup.sh einmal` |
| Backup prüfen | `docker compose -f deploy/docker-compose.prod.yml exec backup bash /backup.sh pruefen` |
| Backups zeigen | `bash deploy/restore.sh` |
| Wiederherstellen | `bash deploy/restore.sh trackinsight-JJJJ-MM-TT.sql.gz` |
| Konfiguration ändern | `nano deploy/.env.prod`, dann `docker compose -f deploy/docker-compose.prod.yml up -d` |
