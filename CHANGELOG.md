# Änderungen

Alle sichtbaren Änderungen, neueste zuerst. Versionen folgen [Semantic Versioning](https://semver.org/lang/de/): Hauptversion bei grossen Umbauten, Nebenversion bei neuen Funktionen, Patch bei Fehlerkorrekturen. Datenbank-Migrationen laufen beim Start automatisch; zum Zurückgehen siehe docs/BETRIEB.md.

## Unveröffentlicht

### Neu
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
