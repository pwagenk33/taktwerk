# Datenschutz nach DSG: Löschkonzept und Auskunft

Gilt für jede Installation von TrackInsight. Die Firma, die TrackInsight einsetzt, ist Verantwortliche nach Art. 5 lit. j DSG; der Betreiber der Installation ist Auftragsbearbeiter (Vorlage für den Vertrag: `docs/AVV-Vorlage.md`).

## Welche Personendaten die Anwendung speichert

| Datenart | Beispiele | Zweck | Rechtsgrundlage / Aufbewahrung |
|---|---|---|---|
| Konto | Name, E-Mail, Benutzername, Rolle, Team, Pensum, Ferienanspruch | Anmeldung, Zuordnung der Buchungen | Vertrag; bis Austritt, danach anonymisiert |
| Anmeldedaten | Passwort-Hash, Zwei-Faktor-Geheimnis, Wiederherstellungscodes, Passkeys, Microsoft/Google-Verknüpfung | Sicherheit der Anmeldung | bis Austritt, bei Anonymisierung gelöscht |
| Sitzungen | Gerät (User-Agent), IP-Adresse, letzte Aktivität | Sitzungsübersicht, «Überall abmelden» | 30 Tage nach letzter Aktivität, dann automatisch gelöscht |
| Zeitbuchungen | Datum, Stunden, Start, Tätigkeit, Projekt | Leistungsnachweis, Rechnung, Arbeitszeitkontrolle | Art. 958f OR (10 Jahre als Geschäftsunterlage), Art. 73 ArGV 1 (5 Jahre Arbeitszeit) |
| Spesen und Belege | Betrag, Kategorie, Beleg-Datei | Rückerstattung, Rechnung, Buchhaltung | Art. 958f OR, 10 Jahre |
| Absenzen | Art (Ferien, Krankheit, Unfall …), Zeitraum, Notiz | Saldo, Bewilligung | Krankheit/Unfall sind besonders schützenswert; Notizen werden bei der Anonymisierung gelöscht, die Art bleibt für den Saldo |
| Monats- und Wochenabschlüsse | Status, Zeitpunkte, freigebende Person | Nachvollziehbarkeit | wie Zeitbuchungen |
| Protokoll | wer hat wann welche Buchung geändert | Revision | wie Zeitbuchungen |
| Erinnerungen | Kanal, Uhrzeit, Webhook-URL | persönliche Erinnerung | bis Austritt |
| Kundenportal-Konten | Name, E-Mail der Kundenkontakte | Zugang zu Reports und Rechnungen | bis die Firma den Zugang entzieht |

Nicht gespeichert werden: Standort, Gesundheitsdaten über die Absenzart hinaus, Inhalte aus JIRA ausser Schlüssel, Titel und Story Points.

## Wo die Daten liegen

- Datenbank (MariaDB) und Belege (`DATA_DIR/receipts`) auf dem Server in der Schweiz (siehe `docs/BETRIEB.md`).
- Backups: nächtlich, 30 Tage, verschlüsselter S3-Bucket in der Schweiz. Gelöschte oder anonymisierte Daten verschwinden damit spätestens 30 Tage später auch aus den Backups.
- E-Mails gehen über den konfigurierten SMTP-Server der Firma; Teams- und Slack-Erinnerungen über die vom Mitarbeitenden selbst hinterlegte Webhook-URL.

## Auskunft (Art. 25 DSG)

- Jede Person lädt unter **Profil → Meine Daten** eine JSON-Datei mit allem herunter, was über sie gespeichert ist (`GET /api/me/export`).
- Für ausgetretene Personen lädt ein Admin die Datei unter **Einstellungen → Benutzer → Auskunft** (nur bei deaktivierten Konten sichtbar, `GET /api/users/:id/export`).
- Frist: 30 Tage. Technische Geheimnisse (Passwort-Hash, Zwei-Faktor-Geheimnis, Sitzungs-Token) sind nicht Teil der Auskunft.

## Löschung und Anonymisierung

1. **Austritt:** Admin deaktiviert das Konto (Einstellungen → Benutzer → Deaktivieren). Anmeldung ist sofort unmöglich, alle Sitzungen enden.
2. **Nach Ablauf der Kündigungsfrist** (Empfehlung: spätestens 3 Monate nach Austritt): Admin klickt **Anonymisieren** und bestätigt mit dem eigenen Passwort. Das entfernt unwiderruflich Name, E-Mail, Benutzername, Passwort, Zwei-Faktor, Passkeys, Microsoft/Google-Verknüpfung, Erinnerungen, Dashboard, Planung und Absenz-Notizen. Buchungen, Spesen, Absenzarten und Abschlüsse bleiben unter «Ehemalige Person» erhalten, weil sie Geschäftsunterlagen sind.
3. **Nach 10 Jahren** (Art. 958f OR) dürfen die verbleibenden Buchungen gelöscht werden: Zeitbuchungen und Spesen der anonymisierten Person per SQL oder per Export der Firma; ein Knopf dafür ist bewusst nicht vorgesehen.
4. **Kundenportal:** Zugang entziehen auf der Kundenseite löscht das Portal-Konto vollständig (keine Geschäftsunterlagen daran).
5. **Ganze Firma** (Mandant): der Betreiber deaktiviert die Firma (Einstellungen → Betreiber), exportiert auf Wunsch alle Daten (Einstellungen → Berichte & Export) und löscht nach Ablauf der Aufbewahrungsfristen die Organisation mit allen Tabellen per `docs/BETRIEB.md` → «Firma entfernen».

Automatisch gelöscht werden: abgelaufene Sitzungen und verbrauchte Passwort-Links (Job «Aufräumen», alle 15 Minuten), Backups nach 30 Tagen.

## Meldungen und Rechte

- Datensicherheitsverletzung (Art. 24 DSG): Betreiber informiert die Firma innert 24 Stunden (AVV Ziffer 7); die Firma meldet dem EDÖB, wenn ein hohes Risiko besteht.
- Berichtigung: Personen ändern Name und E-Mail im Profil; Admins ändern Rolle, Team und Arbeitsmodell.
- Datenübertragbarkeit (Art. 28 DSG): die Auskunfts-Datei ist maschinenlesbar (JSON); Buchungen gibt es zusätzlich als CSV unter Berichte & Export.
