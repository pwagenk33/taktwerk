# TrackInsight in Power BI

Die Vorlage holt alle Auswertungsdaten über die öffentliche API (Paket Business): Kunden, Projekte, Teilprojekte, Mitarbeitende, Buchungen, Spesen, Absenzen, Budgets mit Forecast und Rechnungen.

## Einrichten (Power BI Desktop, etwa 10 Minuten)

1. In TrackInsight unter **Einstellungen → API & Webhooks** einen Schlüssel **«Nur lesen»** erstellen und kopieren.
2. Auf derselben Seite **«Power-BI-Vorlage herunterladen»**. Die Datei `TrackInsight-PowerBI.pq` enthält die Adresse eurer Firma schon.
3. Power BI Desktop → **Daten abrufen → Leere Abfrage → Erweiterter Editor**. Für jeden Block der Datei eine eigene Abfrage anlegen und sie so nennen, wie es in der Zeile `// Abfrage: …` steht. Reihenfolge: `BaseUrl`, `ApiKey`, `StartDatum`, `fnTrackInsight`, `fnSeiten`, danach die Tabellen.
4. Beim Parameter `ApiKey` den Schlüssel einfügen. `StartDatum` bestimmt, ab wann Buchungen und Spesen geladen werden.
5. Bei der Frage nach Anmeldedaten **Anonym** wählen (der Schlüssel steckt in der Kopfzeile).
6. Im Modell die Beziehungen setzen: Buchungen → Projekte, Teilprojekte, Mitarbeitende; Projekte → Kunden; Budgets → Projekte.

## Hinweise

- Buchungen und Spesen werden pro Jahr und in Seiten zu 1000 Zeilen geladen; das API-Limit von 300 Anfragen pro Minute reicht für mehrere hunderttausend Buchungen.
- Für die automatische Aktualisierung im Power BI Service die Datenquelle ebenfalls auf **Anonym** stellen und, falls verlangt, «Testverbindung überspringen» aktivieren.
- Beträge sind in der Währung des Kunden (`currency`); Buchungen enthalten Stundensatz und Betrag zum Buchungszeitpunkt.
- Der Schlüssel handelt mit den Rechten der Admin-Person, die ihn erstellt hat. Wird sie deaktiviert, hört die Aktualisierung auf.
