// Power BI template: Power Query (M) for the public API. Settings → API & Webhooks downloads it with the
// company's address filled in; docs/POWERBI.md explains the steps.

export function powerBiTemplate(baseUrl: string) {
  return `// TrackInsight → Power BI (Power Query M)
// Anleitung: docs/POWERBI.md. Kurz: In Power BI Desktop für jeden Block unten «Daten abrufen → Leere Abfrage»,
// «Erweiterter Editor», Block einfügen und die Abfrage so benennen, wie es in der Zeile «// Abfrage:» steht.
// Den API-Schlüssel (nur lesen) erstellt ein Admin unter Einstellungen → API & Webhooks.

// Abfrage: BaseUrl
"${baseUrl}" meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]

// Abfrage: ApiKey
"ti_HIER_SCHLUESSEL_EINFUEGEN" meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]

// Abfrage: StartDatum
#date(2025, 1, 1) meta [IsParameterQuery = true, Type = "Date", IsParameterQueryRequired = true]

// Abfrage: fnTrackInsight
(path as text, optional query as nullable record) as any =>
let
    Response = Web.Contents(BaseUrl, [
        RelativePath = "api/v1/" & path,
        Query = if query = null then [] else query,
        Headers = [Authorization = "Bearer " & ApiKey, #"Accept-Language" = "de"],
        ManualStatusHandling = {401, 403, 429}
    ]),
    Json = Json.Document(Response)
in
    Json

// Abfrage: fnSeiten (lädt Buchungen oder Spesen in Jahresstücken und Seiten zu 1000 Zeilen)
(path as text) as table =>
let
    Today = Date.From(DateTime.LocalNow()),
    Years = List.Generate(() => StartDatum, each _ <= Today, each Date.AddYears(_, 1)),
    Chunk = (from as date) as list =>
        let
            To = List.Min({Date.AddDays(Date.AddYears(from, 1), -1), Today}),
            Page = (offset as number) => fnTrackInsight(path, [
                from = Date.ToText(from, "yyyy-MM-dd"), to = Date.ToText(To, "yyyy-MM-dd"),
                limit = "1000", offset = Text.From(offset)
            ]),
            Pages = List.Generate(
                () => [o = 0, r = Page(0)],
                each List.Count([r][data]) > 0,
                each [o = [o] + 1000, r = if [o] + 1000 >= [r][total] then [data = {}] else Page([o] + 1000)],
                each [r][data]
            )
        in
            List.Combine(Pages),
    Rows = List.Combine(List.Transform(Years, Chunk)),
    Table = Table.FromRecords(Rows)
in
    Table

// Abfrage: Kunden
let
    Source = fnTrackInsight("customers")[data],
    T = Table.FromRecords(Source, {"id", "name", "currency", "language"}),
    Typed = Table.TransformColumnTypes(T, {{"id", type text}, {"name", type text}, {"currency", type text}, {"language", type text}})
in
    Typed

// Abfrage: Projekte
let
    Source = fnTrackInsight("projects")[data],
    T = Table.FromRecords(Source, {"id", "customerId", "name", "budget", "kind", "jiraProjectKey", "leadUserId"}),
    Typed = Table.TransformColumnTypes(T, {{"budget", type number}})
in
    Typed

// Abfrage: Teilprojekte
let
    Source = fnTrackInsight("projects")[data],
    Rows = List.Combine(List.Transform(Source, (p) => List.Transform(p[subProjects], (s) => Record.AddField(s, "projectId", p[id])))),
    T = Table.FromRecords(Rows, {"id", "projectId", "name", "budget", "jiraEpicKey"}),
    Typed = Table.TransformColumnTypes(T, {{"budget", type number}})
in
    Typed

// Abfrage: Mitarbeitende
let
    Source = fnTrackInsight("employees")[data],
    T = Table.FromRecords(Source, {"id", "name", "role", "teamId", "workload", "personnelNumber"}),
    Typed = Table.TransformColumnTypes(T, {{"workload", type number}})
in
    Typed

// Abfrage: Buchungen
let
    T = fnSeiten("time-entries"),
    Typed = Table.TransformColumnTypes(T, {{"date", type date}, {"hours", type number}, {"hourlyRate", type number}, {"amount", type number}, {"billable", type logical}})
in
    Typed

// Abfrage: Spesen
let
    T = fnSeiten("expenses"),
    Typed = Table.TransformColumnTypes(T, {{"date", type date}, {"amount", type number}, {"billable", type logical}})
in
    Typed

// Abfrage: Absenzen
let
    Source = fnTrackInsight("absences", [from = Date.ToText(StartDatum, "yyyy-MM-dd"), to = Date.ToText(Date.AddYears(Date.From(DateTime.LocalNow()), 1), "yyyy-MM-dd")])[data],
    T = Table.FromRecords(Source, {"id", "employeeId", "employeeName", "type", "startDate", "endDate", "halfDay", "status"}),
    Typed = Table.TransformColumnTypes(T, {{"startDate", type date}, {"endDate", type date}, {"halfDay", type logical}})
in
    Typed

// Abfrage: Budgets (Projekte: Budget, Ist, Rest, Forecast, Status)
let
    Source = fnTrackInsight("budgets")[data],
    T = Table.FromRecords(Source, {"projectId", "customerId", "currency", "budget", "hoursBooked", "actualCost", "remainingBudget", "storyPointsDone", "storyPointsOpen", "remainingHours", "forecastCost", "variance", "status"}),
    Typed = Table.TransformColumnTypes(T, {{"budget", type number}, {"hoursBooked", type number}, {"actualCost", type number}, {"remainingBudget", type number}, {"remainingHours", type number}, {"forecastCost", type number}, {"variance", type number}})
in
    Typed

// Abfrage: Rechnungen
let
    Source = fnTrackInsight("invoices")[data],
    T = Table.FromRecords(Source, {"id", "number", "customerId", "month", "issueDate", "dueDate", "status", "net", "vatRate", "vat", "gross", "currency", "paidAt"}),
    Typed = Table.TransformColumnTypes(T, {{"issueDate", type date}, {"dueDate", type date}, {"net", type number}, {"vat", type number}, {"gross", type number}})
in
    Typed

// Beziehungen im Modell: Buchungen[projectId] → Projekte[id], Buchungen[subProjectId] → Teilprojekte[id],
// Buchungen[employeeId] → Mitarbeitende[id], Projekte[customerId] → Kunden[id], Budgets[projectId] → Projekte[id].
`;
}
