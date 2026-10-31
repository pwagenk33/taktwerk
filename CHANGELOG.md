# Änderungen

Alle sichtbaren Änderungen, neueste zuerst. Versionen folgen [Semantic Versioning](https://semver.org/lang/de/): Hauptversion bei grossen Umbauten, Nebenversion bei neuen Funktionen, Patch bei Fehlerkorrekturen. Datenbank-Migrationen laufen beim Start automatisch; zum Zurückgehen siehe docs/BETRIEB.md.

## Unveröffentlicht

### Schneller
- Die App lädt beim Start rund 440 statt 1400 KB: Seiten, Diagramme und die Übersetzungen kommen erst, wenn sie gebraucht werden, und werden danach im Hintergrund vorgeladen.
- Die Daten für die App sind rund dreimal kleiner (Lasttest mit 50 Personen und 5 Jahren: 3 statt 10 MB). Neu laden ohne Änderungen überträgt praktisch nichts mehr.
- Forecast, Budgets und Überzeit-Saldi rechnen schneller, bei vielen Projekten und Personen etwa doppelt so schnell.

### Neu
- Wochenraster in der Zeiterfassung: eine Zeile pro Subprojekt und Tätigkeit, Stunden direkt in die Tageszellen tippen, Zeilen der Vorwoche übernehmen.
- Projektarten Retainer und Fixpreis: Retainer verrechnen jeden Monat das Kontingent und Mehrstunden nach Aufwand, auf Wunsch als Rechnungsentwurf am 1. des Monats (Einstellungen, standardmässig aus). Fixpreis-Projekte werden in Tranchen in Prozent verrechnet, höchstens 100 %.
- Offerten beim Kunden: Positionen mit Stunden und Satz, PDF in der Sprache des Kunden. Wird eine Offerte angenommen, entsteht daraus das Projekt mit einem Subprojekt und Budget pro Position.
- Velocity pro Team und nach Issue-Typ (Story, Bug, Task), dazu eine Liste der Ausreisser, die deutlich mehr Stunden pro Story Point brauchten. Der Issue-Typ kommt beim Jira-Abgleich mit.
- Vorschläge für Buchungstexte: unter dem Feld «Grund» stehen laufende Jira-Issues, eigene Texte der letzten 30 Tage und Texte des Teams; ein Klick übernimmt. Im Bericht fasst «Monatszusammenfassung» die erledigten Issues und Themen eines Kunden als Text zum Kopieren zusammen. Beides regelbasiert aus den eigenen Daten, ohne KI-Dienst.
- TrackInsight auf Italienisch, für Oberfläche, E-Mails, Rechnungen, Offerten und Kundenberichte.
- Automatische Prüfung bei jeder Änderung auf GitHub: Typen, alle Tests gegen MariaDB, Build und Docker-Image.
- Wöchentlicher Wiederherstellungs-Test der Backups mit Ergebnis auf der Statusseite (docs/BETRIEB.md, Abschnitt 11).
- Website: Seiten zum Umsteigen (Import, Alternativen zu Clockodo, Toggl und Harvest), für Agenturen und Treuhänder, ein Ratgeber zur Arbeitszeiterfassung nach ArGV 1 und ein Rechner für unverrechnete Zeit. Preise, Funktionen und Roadmap zeigen die Neuerungen.
- Offene API und Webhooks (Einstellungen → API, Paket Business): API-Schlüssel nur lesend oder lesend und schreibend, Endpunkte /api/v1 für Kunden, Projekte, Personen, Buchungen (auch anlegen, ändern, löschen), Spesen, Absenzen, Budgets mit Forecast und Rechnungen, Beschreibung als OpenAPI unter /api/v1/openapi.json. Webhooks schicken Änderungen an Buchungen, Spesen, Absenzen, Monatsabschlüssen und Rechnungen signiert per HTTPS, mit Wiederholungen und Verlauf. Anleitung in docs/API.md.
- Lohnexport (Monatsabschluss → Lohnexport): pro Person und Monat Stunden, Soll, Überzeit, Absenztage nach Art und Spesen zur Rückerstattung als CSV mit den eigenen Lohnarten und der Personalnummer (neu im Arbeitsmodell). Für den Import in Lohnprogramme, keine Swissdec-Übermittlung.
- bexio (Einstellungen → Rechnung): Rechnungen gehen auf Knopfdruck als Entwurf nach bexio, mit Kunde als Kontakt, Positionen und MWST-Satz. Braucht eine bexio-App des Betreibers (docs/BETRIEB.md, Abschnitt 18).
- Termine aus Outlook (Microsoft 365) oder Google Kalender als Buchungsvorschläge: im Profil den eigenen Kalender verbinden, danach stehen noch nicht gebuchte Termine gestrichelt in der Zeiterfassung. Ein Klick bucht mit Zeit, Dauer, Titel und vorgeschlagenem Subprojekt. TrackInsight liest nur und speichert keine Termine.
- Zeiten als Worklog nach Jira (Einstellungen → Jira): Buchungen mit Issue-Schlüssel erscheinen ab einem gewählten Datum als Worklog am Issue, Änderungen und Löschungen folgen beim Abgleich. Bestehende Jira-Verbindungen müssen dafür einmal neu verbunden werden (Schreibrecht). Anleitung für den Eintrag im Atlassian Marketplace in docs/MARKETPLACE.md.
- TrackInsight auf Französisch und Englisch: Sprache im Profil oder auf der Anmeldeseite wählen, sonst gilt die Sprache des Browsers. E-Mails gehen in der Sprache der empfangenden Person, Rechnungen, Kundenberichte und Kundenportal in der Sprache, die beim Kunden hinterlegt ist. Zahlen und Daten erscheinen im passenden Format (z. B. «12 300 CHF» auf Französisch).
- Geführter Start für neue Firmen: Checkliste «Erste Schritte» im Eingang, Beispieldaten auf Knopfdruck (drei Kunden mit sechs Wochen Buchungen, mit einem Klick wieder entfernt) und Hilfe direkt in der App über «?» oben rechts oder die Taste ?.
- Import aus Clockodo, Toggl Track, Harvest und Excel (Einstellungen → Import): Datei wird erkannt, Spalten lassen sich anpassen, Personen werden zugeordnet, fehlende Kunden, Projekte und Tätigkeiten entstehen automatisch. Abgeschlossene Monate bleiben unberührt, jeder Import lässt sich rückgängig machen.
- Website in den neuen Farben, mit aktuellen Bildern der App und Grundlagen für Suchmaschinen: Sitemap, kanonische Adressen, Vorschaubilder und strukturierte Daten zu Produkt, Preisen und FAQ.
- Neue Farben «Bunt mit System»: Violett als Hauptfarbe, jede Kennzahl mit eigener Farbe, Ampeln unabhängig von der Hauptfarbe. Firmen mit der bisherigen Standardfarbe Rot erhalten Violett; eine eigene Farbe bleibt.
- Alles, was man anlegt oder bearbeitet, öffnet sich jetzt in einem einheitlichen Fenster mit Pflichtfeldern, Hinweisen und Fehlern direkt am Feld.
- Die Website läuft lokal unter http://website.localhost:3000.
- Jira Cloud verbinden (Einstellungen → Jira): Anmeldung bei Atlassian mit einem Klick, Jira-Projekte übernehmen oder bestehenden Projekten zuordnen, Epics werden zu Subprojekten, Issues und Story Points werden alle 15 Minuten abgeglichen.
- Roadmap-Seite auf der Website.
- Öffentliche Website für trackinsight.ch: Funktionen, Preise direkt aus den Paketen, Sicherheit und Datenschutz, Kontaktformular sowie Vorlagen für Impressum, Datenschutz, AGB und AVV. Läuft im selben Container wie die App.
- SaaS-Betrieb mit Abo (Umgebungsvariable `SAAS=true`): Pakete Start, Team und Business nach Teamgrösse, 30 Tage kostenlos testen, Bezahlung per Karte über Stripe oder auf Rechnung, monatlich oder jährlich mit zwei Gratismonaten.
- Einstellungen → Abo: Paket wählen und wechseln, Personen im Paket, Kündigen und Kündigung zurücknehmen, Zahlungsdaten und Quittungen.
- Hinweis oben in der App, wenn die Testphase bald endet oder eine Zahlung offen ist; ohne Paket bleiben alle Daten lesbar und exportierbar.
- Jede Firma unter ihrer eigenen Adresse (firma.trackinsight.ch), Business auch unter einer eigenen Domain mit automatischem Zertifikat.
- Einrichtungsassistent für neue Firmen: Name und Farbe, Arbeitszeit, erster Kunde mit Projekt, Team einladen.
- Betreiber-Übersicht mit monatlichem Umsatz, zahlenden Firmen, Testphasen und Paket pro Firma.
- Neue Startseite «Eingang»: knappe Budgets, offene Freigaben (Absenzen, Spesen, Monatsabschlüsse) und eigene Pendenzen in einer Liste, direkt bewilligen oder ablehnen, Details zum Budget in der rechten Spalte.

### Neu gestaltet
- Ruhiges Erscheinungsbild in warmen Grautönen mit der Schrift Instrument Sans; Schwarz für Aktionen, die Firmenfarbe nur noch für das, was Aufmerksamkeit braucht. Knöpfe im Stil «Schweizer Raster» (kantig, kräftiger Rand, Nebenaktionen als unterstrichener Text), eckige Felder und Kennzahlen-Leisten, Budget-Ringe statt Punkte, Personen mit Initialen.
- Menü ohne Symbole mit Zähler beim Eingang, den Projekten mit Budgetstatus und dem Bereich «Auswerten». Das anpassbare Widget-Dashboard ist dort unter «Dashboard» zu finden.

### Verbessert
- Wer diesen Monat neu angefangen hat, sieht keinen Hinweis mehr auf einen offenen Vormonat.

## 1.0.0 – 2026-10-19

### Neu
- Mehrere Firmen auf einer Installation, strikt getrennt, mit eigener Domain und eigenem Design (Einstellungen → Betreiber, Selbstregistrierung unter /registrieren).
- Versionsnummer und diese Änderungsliste in der App (Klick auf die Version unten links).
- Zwei-Faktor-Anmeldung mit Authenticator-App und Wiederherstellungscodes, Passkeys (Face ID, Touch ID, Windows Hello), Übersicht der angemeldeten Geräte und «Überall sonst abmelden» (Profil → Sicherheit).
- Feinere Rollen: Projektleitung pro Projekt (sieht Budget, Buchungen und Report ihres Projekts und plant es), Teamleitung pro Team (bewilligt Absenzen und Monatsabschlüsse ihres Teams), Treuhand mit Nur-Lesen-Zugang.
- Datenschutz nach DSG: Auskunft als Datei unter Profil → Meine Daten, Anonymisieren ausgetretener Personen (Buchungen bleiben erhalten), Löschkonzept in docs/DATENSCHUTZ.md.
- Arbeitszeiterfassung pro Firma wählbar: vereinfacht nach Art. 73b ArGV 1 oder Kommen/Gehen mit Pausen, mit Prüfung von Pausen, Ruhezeit und Nachtarbeit.
- Schneller mit vielen Daten: ältere Monate werden als Summen geladen, grosse Antworten komprimiert (getestet mit 200 Kunden, 50 Personen, 5 Jahren).
- Ressourcenplanung: Personen × Wochen gegen Kapazität, Projekte gegen Restbudget, Engpässe Wochen im Voraus.
- Kundenportal: Kundenkontakte sehen Budget, Restbudget, Prognose, Monatsreports und Rechnungen ihrer Firma.
- Projektarten Zeit und Material, Fixpreis und Retainer; Profitabilität pro Projekt und Kunde; Kunden in CHF, EUR oder USD mit Tageskurs.
- Forecast-Szenarien, Wochenmail an die Projektleitung, Monatsmail an die Geschäftsführung, Datenexport als CSV oder JSON, Widgets Auslastung, offene Rechnungen, Ferienplan und Top-Kunden.
- Stoppuhr, Tag und Woche kopieren, Tastenkürzel, suchbare Auswahlfelder, Kommentare und Rückfragen pro Buchung, installierbare Handy-App mit Offline-Puffer, Wochenfreigabe, persönliche Erinnerungen per E-Mail, Teams oder Slack, Beleg-OCR.

### Grundlage
- Zeiterfassung mit Wochenkalender, Arbeitszeit und Absenzen, Spesen mit Belegen, Monatsabschluss, Kundenreports mit JIRA-Forecast, Rechnungen mit QR-Rechnung, Anmeldung mit Passwort, Microsoft und Google.
