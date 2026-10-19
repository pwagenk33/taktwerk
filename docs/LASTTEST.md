# Lasttest

Ziel aus der Roadmap: flüssig mit **200 Kunden, 50 Mitarbeitenden und 5 Jahren Daten**.

## So läuft der Test

```bash
# einmalig: leere Datenbank, deren Name «load» enthält
sudo mysql -e "CREATE DATABASE taktwerk_load; GRANT ALL ON taktwerk_load.* TO 'taktwerk'@'localhost';"
cd server
npm run loadtest            # erzeugt die Daten neu und misst
npm run loadtest -- --keep  # misst nur, Daten bleiben
```

Das Skript `server/scripts/loadtest.ts` legt eine Firma mit 200 Kunden, 400 Projekten, 1200 Subprojekten und 50 Personen an und bucht 5 Jahre lang an jedem Arbeitstag das Pensum (rund 265 000 Buchungen, 3000 Spesen, 1150 Absenzen, 3000 Monatsabschlüsse). Dann misst es die schweren Endpunkte, je Median aus drei Aufrufen.

## Ergebnis (2026-10-19, Testcontainer mit MariaDB 11)

| Endpunkt | Rolle | vorher | nachher | Daten (gzip) vorher | nachher |
|---|---|---|---|---|---|
| Alle Daten für die App (`/api/dataset`) | Admin | 2.8 s | 0.24 s | 61 MB (13 MB) | 10 MB (1.2 MB) |
| Alle Daten für die App | Mitarbeitende | 58 ms | 26 ms | 1.6 MB | 0.4 MB (0.08 MB) |
| Projekt-Reports (`/api/reports`) | Admin | 1.4 s | 0.20 s | 0.8 MB | 0.8 MB (0.14 MB) |
| Export Buchungen ab Monatsanfang | Admin | 1.2 s | 0.15 s | 0.3 MB | 0.3 MB |
| Monatsabschluss, Abschlüsse | Admin | < 15 ms | < 15 ms | klein | klein |

Der erste Aufruf nach einem Neustart oder Monatswechsel braucht einmalig rund 2.5 s, weil die Monatssummen berechnet werden; danach kommen sie aus dem Speicher.

## Was geändert wurde

- **Einzelbuchungen nur für die letzten Monate:** Die App erhält die Buchungen des laufenden Monats und der drei Monate davor einzeln, ältere als Monatssummen pro Person, Subprojekt, Ticket und Stundensatz. Budgets, Saldi, Velocity, Margen und Reports bleiben exakt, weil sie nur Summen brauchen. Wer im Kalender weiter zurückblättert, lädt die Einzelbuchungen dieser Wochen automatisch nach.
- **Monatssummen im Speicher:** Sie werden pro Firma einmal berechnet und nur verworfen, wenn sich eine Buchung vor dem Fenster ändert.
- **Komprimierung:** Antworten über 32 KB gehen gzip-komprimiert raus (auch ohne Caddy, also im lokalen Docker-Betrieb).
- **Indizes:** zusätzlich `time_entries (user_id, date)` und `expenses (user_id, date)` für die Abfragen pro Person (Migration 0015).
- **Paginierung:** Rechnungsliste seitenweise (`limit`, `before`); die Kundenliste zeigt 50 pro Seite; Listen in der Zeiterfassung sind auf Wochen begrenzt.
- **Export** lädt nur den gewählten Zeitraum einzeln.

`/api/dataset?all=1` liefert weiterhin alles einzeln, etwa für eigene Auswertungen.
