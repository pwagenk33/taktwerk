# Features und Verbesserungsvorschläge

Stand 18.10.2026. ★ = meine Empfehlung für die nächsten Schritte. ✅ = umgesetzt.

## A. Lücken im heutigen Stand

| # | Vorschlag | Warum |
|---|---|---|
| A1 ✅ | **Buchungen bearbeiten und löschen**, mit Änderungsprotokoll | Heute kann man nur erfassen. Ohne Korrektur ist kein Monatsabschluss möglich. |
| A2 ✅ | **Monatsabschluss mit Freigabe**: Mitarbeitende reichen den Monat ein, Consultant/Admin gibt frei, danach ist er gesperrt | Verrechnete Stunden dürfen sich nachträglich nicht mehr ändern. |
| A3 ★ | **Echte JIRA-Anbindung**: Sync per Webhook + nächtlicher Abgleich, Story-Point-Feld und Epic-Mapping im Admin wählbar | Heute stammen die Issues aus Beispieldaten. Das ist der Kern des Forecasts. |
| A4 | **Server liefert Kennzahlen statt alle Rohdaten** (Aggregation, Paging, nächtliche Velocity-Snapshots) | Bei Grossunternehmen mit 100 000+ Buchungen wird das Laden sonst langsam. |
| A5 | **Zwei-Faktor-Anmeldung (TOTP)** für Logins mit Passwort | Für Grosskunden oft Pflicht. Bei Microsoft/Google regelt das der Anbieter. |

## B. Zeiterfassung

| # | Vorschlag | Warum |
|---|---|---|
| B1 ★ | **Wochenraster** (Timesheet: Zeilen = Subprojekte, Spalten = Tage) | Viele erfassen am Freitag die ganze Woche, das geht so am schnellsten. |
| B2 ✅ | **Favoriten und zuletzt verwendet** für Kunde/Projekt/Issue | Weniger Klicks bei jeder Buchung. |
| B3 ✅ | **Erinnerung per E-Mail**, wenn Stunden fehlen (z. B. Montag für die Vorwoche) | Vollständige Daten machen den Forecast genauer. |
| B4 ✅ | **Arbeitszeit, Ferien, Absenzen, Überzeit** (Soll/Ist pro Person) | In der Schweiz besteht grundsätzlich eine Pflicht zur Arbeitszeiterfassung (ArGV 1, Art. 73). Damit wird das Tool auch für HR nutzbar. |
| B5 | **App fürs Handy (PWA)** mit Stoppuhr, auch offline | Erfassen direkt beim Kunden vor Ort. |
| B6 | **Vorschläge aus dem Outlook-/Google-Kalender** | Meetings werden mit einem Klick zur Buchung. |

## C. Spesen

| # | Vorschlag | Warum |
|---|---|---|
| C1 ✅ | **Beleg als Foto hochladen** (Auslesen von Betrag und Datum noch offen) | Spart Abtippen, der Beleg ist beim Kunden-Audit griffbereit. |
| C2 ✅ | **Kilometerpauschale** (z. B. CHF 0.70/km) und **MwSt-Ausweis** | Häufigste Spesenart bei Beratung vor Ort. |
| C3 ✅ | **Spesen-Freigabe** durch Projektleitung | Kontrolle vor der Weiterverrechnung. |

## D. Reporting, Forecast und Abrechnung

| # | Vorschlag | Warum |
|---|---|---|
| D1 ✅ | **Kundenreport als PDF und Excel** im Corporate Design, **monatlich automatisch per E-Mail** | Das ist das Produkt, das deine Kunden sehen. |
| D2 ✅ | **Budget-Alarm** per E-Mail bei 80 %, 95 % und 100 % des Forecasts | Probleme früh sehen, nicht erst bei der Rechnung. |
| D3 ✅ | **Rechnung als Swiss-QR-Rechnung** (Export an Bexio/Abacus noch offen) | Schliesst den Kreis von der Zeit bis zum Geld, wichtig für KMU in der Schweiz. |
| D4 | **Sätze pro Rolle/Person beim Kunden** (Senior/Junior), **Fixpreis- vs. Aufwandsprojekte**, Rabatte | Bildet echte Verträge ab. |
| D5 | **Marge/Deckungsbeitrag**: interne Kosten pro Stunde vs. Kundensatz | Zeigt, welche Kunden sich wirklich lohnen (nur für Admins). |
| D6 | **Kapazitätsplanung**: Fertigstellungsdatum aus verfügbaren Personen statt nur aus Durchsatz, plus **Szenarien** («2 Personen mehr ab Januar») | Antwortet auf die häufigste Kundenfrage: «Wann seid ihr fertig?» |
| D7 | **Velocity pro Team, Issue-Typ und Person**, Ausreisser ausblenden, **nachträglich geänderte Story Points erkennen** | Macht den h/SP-Faktor robuster und erklärt, warum er steigt (z. B. von 3.5 auf 6.5). |
| D8 | **Kundenportal**: Lesezugang für Kunden auf ihren eigenen Report | Weniger Report-Mails, mehr Transparenz. |

## E. Dashboard und Bedienung

| # | Vorschlag | Warum |
|---|---|---|
| E1 | **Globaler Filter** (Zeitraum, Kunde, Team) für alle Widgets und **Drilldown** per Klick | Vom Überblick direkt ins Detail. |
| E2 | **Dashboard-Vorlagen pro Rolle** und teilbare Dashboards | Neue Personen starten mit einer sinnvollen Ansicht. |
| E3 | **Neue Widgets**: Auslastung vs. Kapazität, offene Freigaben, Top-Abweichungen, Spesen pro Monat | |
| E4 | **Mehrsprachig** (DE/FR/IT/EN) | Für Kunden in der ganzen Schweiz. |

## F. Enterprise und Betrieb

| # | Vorschlag | Warum |
|---|---|---|
| F1 | **Rechte pro Kunde**: Consultants sehen nur ihre Kunden | Bei Grossunternehmen zwingend. |
| F2 ✅ | **Audit-Log** (wer hat was wann geändert) | Revision, Datenschutz (revDSG). |
| F3 | **SAML** zusätzlich zu Microsoft/Google, **Benutzer-Sync** aus Entra ID | Grosskunden verwalten Zugänge zentral. |
| F4 | **Backups, Monitoring, Mandantenfähigkeit** (mehrere Firmen pro Installation) | Für den Betrieb als SaaS. |

## Empfohlene Reihenfolge

1. ~~**Abrechnung sauber machen:** A1, A2, D1, D2~~ ✅ erledigt.
2. **JIRA live:** A3, D7 (braucht Zugang zu einem JIRA-Board).
3. ~~**Komfort beim Erfassen:** B1, B2, B3, danach B4 für Arbeitszeit und Absenzen~~ ✅ erledigt, ebenso C1–C3 und D3.
