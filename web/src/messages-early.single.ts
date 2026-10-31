// Single-file demo: every module is inlined and runs at once, before main.tsx could load the table.
// Registering it here, ahead of everything that imports i18n, lets texts translated at load time switch language too.
import { registerMessages } from "@taktwerk/domain";
import { MESSAGES } from "@taktwerk/domain/messages";

registerMessages(MESSAGES);
