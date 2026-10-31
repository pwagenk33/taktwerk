// Entry point. German needs no translation table; for French and English it is loaded first (its own file, cached),
// so texts that modules translate when they load are already in the right language. Then the app starts.
import { registerMessages } from "@taktwerk/domain";
import { locale } from "./i18n";

const messages = locale === "de" ? Promise.resolve() : import("@taktwerk/domain/messages").then((m) => registerMessages(m.MESSAGES));
messages.catch(() => {}).then(() => import("./root"));
