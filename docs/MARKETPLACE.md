# TrackInsight im Atlassian Marketplace

TrackInsight verbindet sich über OAuth 2.0 (3LO) mit Jira Cloud (siehe [BETRIEB.md](BETRIEB.md), Abschnitt 16). Solche Integrationen installieren nichts in Jira. Atlassian führt sie im Marketplace als **informativen Eintrag** («informational listing») mit eingeschränkten Marketplace-Funktionen: Kundinnen finden TrackInsight dort und werden zur Website geschickt. Kauf und Abo laufen weiter über TrackInsight, nicht über Atlassian.

Quellen (Stand Oktober 2026):
- [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/): Abschnitt zu Distribution und Marketplace
- [Listing a third party integration on the Atlassian Marketplace](https://developer.atlassian.com/platform/marketplace/knowledge-base/listing-a-third-party-integration-on-the-atlassian-marketplace)

Die Anforderungen ändern sich. Vor dem Einreichen bitte die aktuellen Seiten von Atlassian lesen, besonders die Sicherheitsanforderungen für Cloud-Apps.

## Was nur der Betreiber tun kann

1. **Vendor-Konto anlegen.** Auf [marketplace.atlassian.com](https://marketplace.atlassian.com) unter «Publish an app» ein Anbieterprofil erstellen. Nötig sind Firmenname, Kontakt-E-Mail, Website und Supportkontakt.
2. **Sharing einschalten.** In der [Developer Console](https://developer.atlassian.com/console/myapps/) unter **Distribution → Enable sharing**. Ohne Sharing kann nur der Besitzer der App sie nutzen. Sharing allein macht die App noch nicht im Marketplace sichtbar. Bis Atlassian die Integration geprüft hat, zeigt Atlassian Kunden beim Verbinden den Hinweis, dass die App noch nicht geprüft wurde.
3. **Eintrag anlegen.** Im Marketplace **Publish a new app** wählen und dann **My app isn't directly installable**. Atlassian fragt nach:
   - App Key: wird einmal festgelegt, z. B. `ch.trackinsight.jira`.
   - Version, z. B. `1.0.0`.
   - Build-Nummer.
   - Weitere Informationen: «Provide another URL» mit der Website-Adresse.
   - Name: nach den Markenrichtlinien von Atlassian, also z. B. «TrackInsight for Jira», nicht «Jira TrackInsight».
   - Kompatible Anwendung: Jira Cloud.
4. **Testzugang für die Prüfung.** Atlassian prüft die Integration und braucht dafür Zugang zu einer Testinstanz von TrackInsight. Am besten gleich mitgeben: eine Testfirma mit Admin-Login und eine kurze Anleitung (siehe unten).
5. **Rechtliches verlinken.** Datenschutzerklärung, AGB und Supportseite müssen öffentlich erreichbar sein. Die Vorlagen der Website sind noch nicht juristisch geprüft.

## Anleitung für die Prüfer (Entwurf, Englisch)

> 1. Sign in at https://demo.trackinsight.ch with the admin account we provided.
> 2. Open Settings → Jira and click "Connect with Atlassian". Grant access to your test site.
> 3. Pick a Jira project and choose "New project at <customer>". Epics appear as sub-projects; issues and story points sync every 15 minutes or via "Sync now".
> 4. Optional: under "Time as Jira worklog" switch worklogs on. Book time on an issue key in Time tracking; after the next sync the worklog appears on the issue in Jira.
> 5. Velocity and forecast (menu Velocity, Projects) now use the synced story points.
>
> Data read from Jira: issue key, summary, status, story points, epic link. Data written to Jira (only when worklogs are switched on): worklogs with date, duration and "Name: description (TrackInsight)". No API tokens are collected; the integration uses a single distributable OAuth 2.0 (3LO) app.

Die Adresse `demo.trackinsight.ch` ist ein Platzhalter, bis Name und Domain feststehen.

## Eintragstext (Entwurf)

**Name:** TrackInsight for Jira

**Kurzbeschreibung (EN):** Time tracking, budgets and forecasts for agencies and service teams, with story points and worklogs from Jira Cloud.

**Kurzbeschreibung (DE):** Zeiterfassung, Budgets und Forecasts für Agenturen und Dienstleister, mit Story Points und Worklogs aus Jira Cloud.

**Highlights (EN):**
- *Budgets that see the backlog:* TrackInsight learns your team's hours per story point month by month and forecasts the hours that are still needed for the open issues of each project and epic.
- *Time back in Jira:* Every booking on an issue key becomes a worklog on the issue, and changes and deletions follow.
- *Made for Swiss companies:* Customers, rates, expenses, absences, month-end closing and complete working time records under the Swiss Labour Act, with data hosted in Switzerland.

**Beschreibung (EN):**
TrackInsight connects to your Jira Cloud site with one click. Pick the Jira projects you bill to customers. Epics become sub-projects, and issues and story points sync every 15 minutes. Your team books time against customer, project and issue, from the calendar, the timer or on the phone. TrackInsight compares the hours with the story points that are done and computes the velocity per month. The budget forecast for each project and epic follows from that.

With worklogs switched on, bookings go back to Jira as worklogs. Developers then see the time spent right on the issue.

**Screenshots (1840×900 empfohlen; bitte nach aktueller Atlassian-Vorgabe prüfen):**
1. Settings → Jira mit verknüpften Projekten
2. Velocity (Stunden pro Story Point über die Monate)
3. Projekt mit Budget, Forecast und Epics
4. Zeiterfassung mit Issue-Schlüssel
5. Jira-Issue mit TrackInsight-Worklog

**Kategorien:** Time tracking, Project management, Reporting

**Preis:** Im Marketplace nicht verkäuflich (informativer Eintrag). Der Hinweis lautet «Pricing on vendor website» und zeigt auf die Preisseite.

## Offen

- Name und Domain klären. Den App Key erst danach festlegen, denn er lässt sich nicht mehr ändern.
- Prüfen, ob Atlassian für informative Einträge einen Sicherheitsfragebogen oder ein Bug-Bounty verlangt. Die Anforderungen ändern sich, deshalb vor dem Einreichen auf der Sicherheitsseite für Cloud-Apps nachlesen.
- Screenshots aus einer echten Jira-Testsite aufnehmen. Dafür braucht es die App in der Developer Console und eine kostenlose Jira-Cloud-Site.
