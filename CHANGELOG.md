# Änderungen

Alle sichtbaren Änderungen, neueste zuerst. Versionen folgen [Semantic Versioning](https://semver.org/lang/de/): Hauptversion bei grossen Umbauten, Nebenversion bei neuen Funktionen, Patch bei Fehlerkorrekturen. Datenbank-Migrationen laufen beim Start automatisch; zum Zurückgehen siehe docs/BETRIEB.md.

## Unveröffentlicht

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
