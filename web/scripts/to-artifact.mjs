// Turns dist-single/index.html into a page body for the claude.ai Artifact publisher
// (the publisher adds its own doctype/head/body skeleton).
import { readFileSync, writeFileSync } from "node:fs";

const [src = "dist-single/index.html", out = "dist-single/artifact.html"] = process.argv.slice(2);
const html = readFileSync(src, "utf8");
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/g, "");
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
writeFileSync(out, `<meta name="claude:viewport-fit-sides" content="cover">\n${head.trim()}\n${body.trim()}\n`);
console.log(`wrote ${out}`);
