// Entry point. German needs no translation table; for French and English it is loaded first (its own file, cached),
// so texts that modules translate when they load are already in the right language. Then the app starts.
import { registerMessages } from "@taktwerk/domain";
import { locale } from "./i18n";

// A link from Slack or Teams ("#chat-verbinden/<token>") must survive the sign-in, which resets the address.
try {
  const m = /^#chat-verbinden\/(.+)$/.exec(location.hash);
  if (m) sessionStorage.setItem("ti.chatLink", m[1]!);
  // Same for an NFC tag or QR code at a stamp point ("#stempeln/<token>").
  const st = /^#stempeln\/(.+)$/.exec(location.hash);
  if (st) sessionStorage.setItem("ti.stampPoint", st[1]!);
} catch { /* storage blocked: the person opens the link again after signing in */ }

const messages = locale === "de" ? Promise.resolve() : import("@taktwerk/domain/messages").then((m) => registerMessages(m.MESSAGES));
messages.catch(() => {}).then(() => import("./root"));
