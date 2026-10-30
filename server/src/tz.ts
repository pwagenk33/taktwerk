/** UTC offset of Swiss local time on a day, as "+0100" or "+0200" (summer time). */
export function zurichOffset(date: string, time = "12:00") {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "longOffset" }).formatToParts(new Date(Date.UTC(y, m - 1, d, hh, mm))).find((p) => p.type === "timeZoneName")?.value ?? "GMT+01:00";
  return name === "GMT" ? "+0000" : name.replace("GMT", "").replace(":", "");
}
