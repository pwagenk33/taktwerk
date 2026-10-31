import { describe, expect, it } from "vitest";
import { matchChatTarget, parseChatCommand, parseDuration } from "../chat";

describe("chat booking", () => {
  it("reads durations in the usual ways", () => {
    expect(parseDuration(["2h"])?.hours).toBe(2);
    expect(parseDuration(["2,5"])?.hours).toBe(2.5);
    expect(parseDuration(["1:30"])?.hours).toBe(1.5);
    expect(parseDuration(["90m"])?.hours).toBe(1.5);
    expect(parseDuration(["1h30"])?.hours).toBe(1.5);
    expect(parseDuration(["2h", "15m", "x"])).toEqual({ hours: 2.25, used: 2 });
    expect(parseDuration(["25h"])).toBeNull();
    expect(parseDuration(["Muster"])).toBeNull();
  });

  it("parses commands and the Teams mention", () => {
    expect(parseChatCommand("<at>TrackInsight</at> heute")).toEqual({ kind: "today" });
    expect(parseChatCommand("")).toEqual({ kind: "help" });
    expect(parseChatCommand("gestern 1:30 muster web Fix")).toEqual({ kind: "book", hours: 1.5, daysAgo: 1, words: ["muster", "web", "Fix"] });
    expect(parseChatCommand("irgendwas")).toEqual({ kind: "unknown" });
  });

  it("matches the project by leading words and keeps the rest as text", () => {
    const targets = [
      { subProjectId: "a", label: "Muster AG · Website · Startseite" },
      { subProjectId: "b", label: "Muster AG · Website · Shop" },
      { subProjectId: "c", label: "Bäckerei Zürcher · App · Design" },
    ];
    expect(matchChatTarget(["muster", "shop", "Warenkorb", "repariert"], targets)).toEqual({ kind: "match", target: targets[1], reason: "Warenkorb repariert" });
    expect(matchChatTarget(["backerei", "Logo"], targets)).toEqual({ kind: "match", target: targets[2], reason: "Logo" });
    expect(matchChatTarget(["muster", "Telefon"], targets)).toMatchObject({ kind: "ambiguous" });
    expect(matchChatTarget(["nirgends"], targets)).toEqual({ kind: "none" });
  });
});
