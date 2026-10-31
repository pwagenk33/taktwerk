// Collects every German text that goes through tr()/trn() in web, server and domain, plus the values of domain
// constants that are translated where they are shown. Used by the i18n test and by `npm run i18n`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { ABSENCE_TYPES, EXPENSE_CATEGORIES, FEATURE_LABEL, PLANS } from "../packages/domain/src/index";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCES = ["web/src", "server/src", "packages/domain/src"];
const SKIP = /__tests__|node_modules|messages\.ts$|\.d\.ts$|server\/src\/(db|cli\.ts|seed\.ts)/;

/** Texts translated through a variable (tr(x.category)), so no literal tr("…") exists for them. */
const DYNAMIC = [
  ...ABSENCE_TYPES,
  ...EXPENSE_CATEGORIES,
  ...Object.values(FEATURE_LABEL),
  ...PLANS.flatMap((p) => [p.tagline, ...p.highlights]),
  "Stk.", "im Plan", "knapp", "überschritten", "Buchen", "Seiten", "Kunden", "Projekte",
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (SKIP.test(relative(ROOT, p))) return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

export interface KeyUse { key: string; where: string }

export function collectKeys(): KeyUse[] {
  const out: KeyUse[] = DYNAMIC.map((key) => ({ key, where: "dynamic" }));
  for (const dir of SOURCES)
    for (const f of files(join(ROOT, dir))) {
      const src = readFileSync(f, "utf8");
      if (!/\btrn?\(/.test(src)) continue;
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "tr" || n.expression.text === "trn")) {
          const literals = n.expression.text === "trn" ? n.arguments.slice(1, 3) : n.arguments.slice(0, 1);
          for (const a of literals)
            if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) out.push({ key: a.text, where: `${relative(ROOT, f)}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1}` });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { MESSAGES } = await import("../packages/domain/src/messages");
  const known = new Map(MESSAGES.map((m) => [m[0], m]));
  const keys = [...new Map(collectKeys().map((k) => [k.key, k])).values()];
  const missing = keys.filter((k) => !known.get(k.key)?.[1] || !known.get(k.key)?.[2] || !known.get(k.key)?.[3]);
  const used = new Set(keys.map((k) => k.key));
  const unused = MESSAGES.filter((m) => !used.has(m[0]));
  if (process.argv.includes("--all")) console.log(JSON.stringify(keys.map((k) => k.key)));
  else if (process.argv.includes("--json")) console.log(JSON.stringify(missing.map((k) => k.key), null, 0));
  else {
    console.log(`${keys.length} Texte, ${missing.length} ohne Übersetzung, ${unused.length} nicht mehr verwendet.`);
    for (const k of missing.slice(0, 40)) console.log(`  fehlt: ${JSON.stringify(k.key)}  (${k.where})`);
    for (const m of unused.slice(0, 20)) console.log(`  unbenutzt: ${JSON.stringify(m[0])}`);
  }
}
