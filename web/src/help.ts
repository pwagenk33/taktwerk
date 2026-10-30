// Help articles shown in the help panel («?» in the top bar). Each article belongs to a page; the panel opens
// with the article of the page the person is on. Text is short on purpose: what it is for, then the steps.
import { tr } from "./i18n";

export interface HelpArticle {
  id: string;
  /** Page id (hash) the article belongs to; the panel shows it first there. */
  page: string;
  title: string;
  /** Paragraphs; a line starting with "- " is a list item. */
  body: string[];
}

export const HELP: HelpArticle[] = [
  {
    id: "eingang",
    page: "eingang",
    title: tr("Der Eingang"),
    body: [
      tr("Hier steht, was heute eine Entscheidung braucht: Budgets, die knapp werden, Anträge zum Bewilligen und eigene Pendenzen."),
      tr("- Klicken Sie auf ein Budget, um rechts die Zahlen und die Prognose zu sehen."),
      tr("- «Bewilligen» erscheint, wenn Sie mit der Maus über einen Antrag fahren."),
      tr("- Ist nichts offen, ist der Eingang leer. Das Dashboard mit allen Kennzahlen erreichen Sie oben rechts."),
    ],
  },
  {
    id: "zeit",
    page: "zeit",
    title: tr("Zeit buchen"),
    body: [
      tr("Im Wochenkalender ziehen Sie mit der Maus über die Zeit, die Sie gearbeitet haben. Danach wählen Sie Kunde, Projekt und Tätigkeit und schreiben kurz, was Sie gemacht haben."),
      tr("- Taste N öffnet überall eine neue Buchung, Taste S startet die Stoppuhr."),
      tr("- Einen Block verschieben Sie mit der Maus, die Länge ändern Sie am unteren Rand."),
      tr("- «Kopieren» übernimmt die Buchungen der Vorwoche."),
      tr("- Am Ende der Woche reichen Sie die Woche mit «Woche einreichen» ein."),
    ],
  },
  {
    id: "spesen",
    page: "zeit",
    title: tr("Spesen erfassen"),
    body: [
      tr("Spesen erfassen Sie in der Zeiterfassung unter «Liste» oder beim Klick auf einen Tag im Kalender über den Reiter «Spese»."),
      tr("- Fotografieren Sie den Beleg; Betrag und Datum werden gelesen und vorgeschlagen."),
      tr("- Mitarbeitende reichen Spesen ein, Consultants oder Admins bewilligen sie. Erst bewilligte Spesen erscheinen auf der Rechnung."),
    ],
  },
  {
    id: "absenzen",
    page: "arbeitszeit",
    title: tr("Ferien und Absenzen"),
    body: [
      tr("Mit «+ Absenz» beantragen Sie Ferien oder tragen Krankheit, Militär oder Weiterbildung ein. Ferien und Kompensation gehen zur Bewilligung an die Teamleitung."),
      tr("- Halbe Tage wählen Sie im Fenster mit «Halbe Tage»."),
      tr("- Den Ferien- und Überzeit-Saldo sehen Sie oben in der Zeiterfassung."),
    ],
  },
  {
    id: "abschluss",
    page: "abschluss",
    title: tr("Monatsabschluss"),
    body: [
      tr("Am Monatsende reicht jede Person ihren Monat ein. Die Teamleitung oder ein Admin prüft und schliesst ab; danach lassen sich die Buchungen nicht mehr ändern."),
      tr("- «Erinnern» schickt allen eine E-Mail, die noch nicht eingereicht haben."),
      tr("- Ein Admin kann einen abgeschlossenen Monat wieder öffnen."),
    ],
  },
  {
    id: "projekte",
    page: "projekte",
    title: tr("Kunden, Projekte und Budgets"),
    body: [
      tr("Ein Kunde hat einen Stundensatz und Projekte. Ein Projekt hat ein Budget, das Sie auf Subprojekte (zum Beispiel Phasen oder Epics) verteilen."),
      tr("- «+ Kunde» und «+ Projekt» öffnen ein Fenster mit allen nötigen Angaben."),
      tr("- Projektarten: Zeit und Material, Fixpreis oder Kontingent mit Stunden pro Monat."),
      tr("- Bei «Bearbeiten» ändern Sie Budget, Projektleitung und Jira-Schlüssel."),
    ],
  },
  {
    id: "forecast",
    page: "velocity",
    title: tr("Wie der Forecast rechnet"),
    body: [
      tr("TrackInsight misst, wie viele Stunden Ihr Team pro Story Point braucht (Velocity), und rechnet die offenen Story Points damit in Stunden und Franken um."),
      tr("- Die Velocity wird Monat für Monat neu gemessen, weil sie sich mit Team und Technik ändert."),
      tr("- Das Band zeigt die beste und schlechteste Velocity der letzten Monate; daraus entsteht die Spanne der Prognose."),
    ],
  },
  {
    id: "planung",
    page: "planung",
    title: tr("Ressourcenplanung"),
    body: [
      tr("Die Planung zeigt pro Person und Woche, wie viele Stunden für Projekte reserviert sind, verglichen mit der Kapazität aus dem Pensum."),
      tr("- Klicken Sie auf eine Zelle, um Stunden für ein Projekt zu reservieren."),
      tr("- Die Farbe zeigt die Auslastung: unter 50 %, 50 bis 90 %, über 90 % und überplant. Die Legende steht über der Tabelle."),
    ],
  },
  {
    id: "reports",
    page: "reports",
    title: tr("Kundenreports und Rechnungen"),
    body: [
      tr("Pro Kunde und Monat entsteht ein Report mit Stunden, Spesen, Budget und Prognose, als PDF oder Excel. Daraus erstellen Sie die Rechnung mit Schweizer QR-Rechnung."),
      tr("- Die Rechnungsadresse erfassen Sie beim Kunden oder direkt bei den Rechnungen."),
      tr("- Reports können jeden Monat automatisch an den Kunden gehen."),
    ],
  },
  {
    id: "import",
    page: "einstellungen",
    title: tr("Daten aus Clockodo, Toggl oder Harvest übernehmen"),
    body: [
      tr("Unter Einstellungen → Import laden Sie den Export Ihres bisherigen Tools hoch. TrackInsight erkennt die Spalten, Sie ordnen die Personen zu, fehlende Kunden und Projekte entstehen automatisch."),
      tr("- Clockodo: Berichte → Stundenzettel, als CSV oder Excel."),
      tr("- Toggl Track: Reports → Detailed → Export → CSV."),
      tr("- Harvest: Reports → Detailed time → Export → CSV."),
      tr("- Jeder Import lässt sich unter «Bisherige Importe» rückgängig machen."),
    ],
  },
  {
    id: "team",
    page: "einstellungen",
    title: tr("Team einladen und Rollen"),
    body: [
      tr("Unter Einstellungen → Benutzer laden Sie Personen per E-Mail ein. Sie setzen ihr Passwort über den Link in der Einladung."),
      tr("- Admin: alles, auch Einstellungen und Abo."),
      tr("- Consultant: alle Kunden, Projekte und Berichte, ohne Einstellungen."),
      tr("- Mitarbeitende: eigene Zeiten und Spesen; mehr, wenn sie ein Projekt oder Team leiten."),
      tr("- Treuhand: sieht alles, ändert nichts, kostet nichts."),
    ],
  },
  {
    id: "jira",
    page: "einstellungen",
    title: tr("Jira verbinden"),
    body: [
      tr("Unter Einstellungen → Jira melden Sie sich bei Atlassian an und wählen die Jira-Projekte aus. Epics werden zu Subprojekten, Story Points und Status werden alle 15 Minuten abgeglichen."),
    ],
  },
  {
    id: "tasten",
    page: "",
    title: tr("Tastenkürzel"),
    body: [
      tr("- ⌘K oder Ctrl+K: suchen und Befehle"),
      tr("- N: neue Buchung"),
      tr("- S: Stoppuhr starten"),
      tr("- ?: diese Hilfe"),
      tr("- Im Kalender: ← und → wechseln die Woche, T springt zu heute, D dupliziert die Buchung unter der Maus"),
    ],
  },
];
