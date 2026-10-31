// Builds the public website (static HTML) into website/dist.
// Pages in src/pages use small directives: <!--@head title="…" description="…"-->, <!--@header page-->, <!--@footer-->,
// <!--@plans--> (price table from packages/domain/src/plans.ts, so website and app always show the same packages)
// and <!--@markdown ../docs/AVV-Vorlage.md--> (legal templates kept in docs/).
// %APP_URL% stays in the output; the server replaces it with APP_URL when it serves a page.
// `node build.mjs --app=https://…` replaces it at build time instead (static preview without the server).
// %SITE_URL% (canonical links, sitemap, preview images) works the same way; `--site=https://…` fills it at build time.
// Search engines get a sitemap, canonical links, Open Graph tags and structured data (product with prices, FAQ).
// French and Italian pages live in src/pages/fr and src/pages/it and are built to /fr/… and /it/…, with their own
// header and footer (partials/header.fr.html …), hreflang links between the language versions and a language switch.
// Legal texts and guides stay German; links to them from French or Italian pages lead to the German page.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const out = resolve(here, process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "dist");
const appUrl = process.argv.find((a) => a.startsWith("--app="))?.slice(6);
const siteUrl = process.argv.find((a) => a.startsWith("--site="))?.slice(7);
/** Static preview: links to other pages end in .html instead of clean URLs. */
const preview = process.argv.includes("--preview");

// Packages come straight from the domain code.
const tmp = join(here, ".plans.mjs");
await build({ entryPoints: [join(here, "../packages/domain/src/plans.ts")], bundle: true, format: "esm", platform: "node", outfile: tmp, logLevel: "error" });
const { PLANS, TRIAL_DAYS, MIN_SEATS } = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
rmSync(tmp);
// Plan names and highlights in French and Italian come from the app's own translation table.
await build({ entryPoints: [join(here, "../packages/domain/src/messages.ts")], bundle: true, format: "esm", platform: "node", outfile: tmp, logLevel: "error" });
const { MESSAGES } = await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
rmSync(tmp);
const COL = { de: 0, fr: 1, it: 3 };
const byDe = new Map(MESSAGES.map((r) => [r[0], r]));
const tx = (lang, de) => (lang === "de" ? de : byDe.get(de)?.[COL[lang]] || de);

const LANGS = ["de", "fr", "it"];
const L = {
  de: { html: "de-CH", og: "de_CH", popular: "Am häufigsten gewählt", per: "pro Person<br>und Monat", monthly: "monatlich verrechnet", yearly: (n) => `CHF ${n} pro Person jährlich verrechnet`, test: (d) => `${d} Tage testen`, langLabel: "Sprache", desc: "Zeiterfassung, Spesen und Absenzen mit Budget-Forecast aus JIRA, QR-Rechnung und Daten in der Schweiz.", perPerson: "pro Person und Monat" },
  fr: { html: "fr-CH", og: "fr_CH", popular: "Le plus choisi", per: "par personne<br>et par mois", monthly: "facturé mensuellement", yearly: (n) => `CHF ${n} par personne facturés annuellement`, test: (d) => `Essai de ${d} jours`, langLabel: "Langue", desc: "Saisie du temps, frais et absences avec prévision budgétaire depuis JIRA, facture QR et données en Suisse.", perPerson: "par personne et par mois" },
  it: { html: "it-CH", og: "it_CH", popular: "Il più scelto", per: "per persona<br>al mese", monthly: "fatturato mensilmente", yearly: (n) => `CHF ${n} per persona fatturati annualmente`, test: (d) => `Prova di ${d} giorni`, langLabel: "Lingua", desc: "Registrazione ore, spese e assenze con previsione del budget da JIRA, fattura QR e dati in Svizzera.", perPerson: "per persona al mese" },
};
/** The same page in every language (German slug, French, Italian) for hreflang links and the language switch. */
const EQUIV = [["index", "index", "index"], ["funktionen", "fonctionnalites", "funzioni"], ["preise", "prix", "prezzi"], ["sicherheit", "securite", "sicurezza"], ["kontakt", "contact", "contatto"]];
const equiv = (lang, page) => EQUIV.find((row) => row[LANGS.indexOf(lang)] === page);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chf = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, "’");
const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function plansHtml(lang) {
  const s = L[lang];
  const cards = PLANS.map((p) => {
    const featured = p.id === "team";
    return `<article class="plan${featured ? " featured" : ""}" aria-labelledby="plan-${p.id}">
  ${featured ? `<p class="plan-flag">${s.popular}</p>` : ""}
  <h3 id="plan-${p.id}">${esc(p.name)}</h3>
  <p class="plan-size">${esc(tx(lang, p.tagline))}</p>
  <p class="plan-price"><span class="cur">CHF</span> <strong data-month="${chf(p.perUser)}" data-year="${chf(Math.round((p.perUser * 10 * 100) / 12) / 100)}">${chf(p.perUser)}</strong> <span class="per">${s.per}</span></p>
  <p class="plan-bill" data-month="${s.monthly}" data-year="${s.yearly(chf(p.perUser * 10))}">${s.monthly}</p>
  <ul>${p.highlights.map((h) => `<li>${esc(tx(lang, h))}</li>`).join("")}</ul>
  <a class="btn${featured ? " primary" : ""}" href="%APP_URL%/registrieren?paket=${p.id}">${s.test(TRIAL_DAYS)}</a>
</article>`;
  }).join("\n");
  return `<div class="plans">${cards}</div>`;
}

/** Enough Markdown for the legal templates: headings, paragraphs, lists, quotes, tables, rules, bold, italic, code, links. */
function markdown(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const lines = md.split("\n");
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { const lvl = Math.min(m[1].length + 1, 4); html.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); i++; continue; }
    if (/^---+\s*$/.test(line)) { html.push("<hr>"); i++; continue; }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r, k) => k !== 1 || !/^\|[\s:|-]+\|$/.test(r));
      html.push(`<div class="table-wrap"><table><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith(">")) {
      const q = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote><p>${inline(q.join(" "))}</p></blockquote>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|>|\||---|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
    html.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return html.join("\n");
}

/** Pages search engines should not list: the 404 page and the legal templates still full of placeholders. */
const NOINDEX = ["404", "avv"];

/** Structured data for the home page: the product with its prices, the provider and the questions from the FAQ. */
function jsonLd(html, lang, home) {
  const text = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const faq = [...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => ({
    "@type": "Question",
    name: text(m[1]),
    acceptedAnswer: { "@type": "Answer", text: text(m[2]).replaceAll("{{trialDays}}", String(TRIAL_DAYS)).replaceAll("{{minSeats}}", String(MIN_SEATS)) },
  }));
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "TrackInsight",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, iOS, Android",
      url: `%SITE_URL%${home}`,
      image: "%SITE_URL%/img/app-eingang.jpg",
      inLanguage: L[lang].html,
      description: L[lang].desc,
      offers: PLANS.map((p) => ({ "@type": "Offer", name: p.name, price: p.perUser.toFixed(2), priceCurrency: "CHF", description: `${p.name}: ${L[lang].perPerson}` })),
      provider: { "@type": "Organization", name: "TrackInsight", url: "%SITE_URL%/" },
    },
    ...(faq.length ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq }] : []),
  ];
  return data.map((d) => `<script type="application/ld+json">${JSON.stringify(d).replaceAll("<", "\\u003c")}</script>`).join("\n") + "\n";
}

/** Partial in the page's language (header.fr.html), else the German one. */
const partial = (name, lang = "de") => {
  const own = join(src, "partials", `${name}.${lang}.html`);
  return readFileSync(lang !== "de" && existsSync(own) ? own : join(src, "partials", `${name}.html`), "utf8");
};
const NAV = {
  de: [["funktionen", "Funktionen"], ["preise", "Preise"], ["sicherheit", "Sicherheit"], ["kontakt", "Kontakt"]],
  fr: [["fonctionnalites", "Fonctionnalités"], ["prix", "Prix"], ["securite", "Sécurité"], ["contact", "Contact"]],
  it: [["funzioni", "Funzioni"], ["prezzi", "Prezzi"], ["sicurezza", "Sicurezza"], ["contatto", "Contatto"]],
};
const pagesDir = (lang) => (lang === "de" ? join(src, "pages") : join(src, "pages", lang));
const PAGES = Object.fromEntries(LANGS.map((lang) => [lang, new Set(readdirSync(pagesDir(lang)).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")))]));
/** Address of a page in language `lang`, seen from a page in language `from` (matters for the static preview). */
const link = (page, lang = "de", from = "de") => {
  if (preview) return `${from !== "de" ? "../" : ""}${lang !== "de" ? `${lang}/` : ""}${page}.html`;
  const prefix = lang === "de" ? "" : `/${lang}`;
  return page === "index" ? `${prefix}/` : `${prefix}/${page}`;
};
/** Path part of the canonical address ("" for the German home page, "fr/prix" …). */
const canonicalPath = (page, lang) => `${lang === "de" ? "" : `${lang}/`}${page === "index" ? "" : page}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pages = [];
for (const lang of LANGS) {
  if (lang !== "de") mkdirSync(join(out, lang), { recursive: true });
  for (const file of readdirSync(pagesDir(lang)).filter((f) => f.endsWith(".html"))) {
    const page = file.replace(/\.html$/, "");
    const row = equiv(lang, page);
    let html = readFileSync(join(pagesDir(lang), file), "utf8");
    html = html.replace(/<!--@head([^>]*)-->/, (_, a) => {
      const { title, description } = attrs(a);
      const alternates = row
        ? LANGS.map((l, i) => `<link rel="alternate" hreflang="${l}" href="%SITE_URL%/${canonicalPath(row[i], l)}">`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="%SITE_URL%/${canonicalPath(row[0], "de")}">\n`
        : "";
      return partial("head")
        .replaceAll("{{title}}", esc(title))
        .replaceAll("{{description}}", esc(description))
        .replaceAll("{{page}}", canonicalPath(page, lang))
        .replace("{{htmlLang}}", L[lang].html)
        .replace("{{ogLocale}}", L[lang].og)
        .replace("{{alternates}}", alternates)
        .replace("{{robots}}", NOINDEX.includes(page) ? '<meta name="robots" content="noindex">\n' : "")
        .replace("{{jsonld}}", page === "index" ? jsonLd(html, lang, `/${canonicalPath("index", lang)}`) : "");
    });
    const langs = LANGS.map((l, i) => {
      const target = row ? row[i] : "index";
      return `<a href="${link(target, l, lang)}" hreflang="${l}" lang="${l}"${l === lang ? ' aria-current="true"' : ""}>${l.toUpperCase()}</a>`;
    }).join("");
    html = html.replace("<!--@header-->", () =>
      partial("header", lang)
        .replace("{{nav}}", NAV[lang].map(([id, label]) => `<a href="${link(id, lang, lang)}"${id === page ? ' aria-current="page"' : ""}>${label}</a>`).join(""))
        .replace("{{langs}}", "<!--@langs-->"));
    html = html.replace("<!--@footer-->", () => partial("footer", lang));
    html = html.replace("<!--@plans-->", () => plansHtml(lang));
    html = html.replace(/<!--@markdown ([^ ]+)-->/g, (_, p) => markdown(readFileSync(resolve(here, p), "utf8")));
    html = html.replace(/\{\{price\.(\w+)\}\}/g, (m, id) => { const p = PLANS.find((x) => x.id === id); return p ? chf(p.perUser) : m; });
    html = html.replaceAll("{{trialDays}}", String(TRIAL_DAYS)).replaceAll("{{minSeats}}", String(MIN_SEATS));
    // Links between pages: the page's own language first, then the German page (legal texts, guides).
    html = html.replace(/href="\/(\w[\w-]*)?"/g, (m, p) => (!p ? `href="${link("index", lang, lang)}"` : PAGES[lang].has(p) ? `href="${link(p, lang, lang)}"` : PAGES.de.has(p) ? `href="${link(p, "de", lang)}"` : m));
    // Language switch after the link rewrite above, which would turn the German "/" into this language's home page.
    html = html.replace("<!--@langs-->", () => `<span class="lang-switch" role="group" aria-label="${L[lang].langLabel}">${langs}</span>`);
    // Sign-up and sign-in from a French or Italian page open the app in that language.
    if (lang !== "de") html = html.replace(/%APP_URL%\/registrieren\?/g, `%APP_URL%/registrieren?lang=${lang}&`).replace(/%APP_URL%\/registrieren"/g, `%APP_URL%/registrieren?lang=${lang}"`).replace(/%APP_URL%\/"/g, `%APP_URL%/?lang=${lang}"`);
    if (preview) {
      const up = lang === "de" ? "" : "../";
      html = html.replace(/<html lang="([^"]+)">/, '<html lang="$1" data-preview="1">').replace(/(href|src)="\/(site\.css|site\.js|favicon\.svg|img\/|fonts\/)/g, `$1="${up}$2`);
    }
    if (appUrl) html = html.replaceAll("%APP_URL%", appUrl);
    if (siteUrl) html = html.replaceAll("%SITE_URL%", siteUrl);
    writeFileSync(join(out, lang === "de" ? "" : lang, file), html);
    if (!NOINDEX.includes(page)) pages.push(canonicalPath(page, lang));
  }
}
// Sitemap with every listed page; the server fills in %SITE_URL% like in the pages.
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.sort().map((p) => `  <url><loc>%SITE_URL%/${p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`;
writeFileSync(join(out, "sitemap.xml"), siteUrl ? sitemap.replaceAll("%SITE_URL%", siteUrl) : sitemap);
const robots = readFileSync(join(src, "robots.txt"), "utf8");
writeFileSync(join(out, "robots.txt"), siteUrl ? robots.replaceAll("%SITE_URL%", siteUrl) : robots);
for (const f of ["site.css", "site.js", "favicon.svg"]) cpSync(join(src, f), join(out, f));
for (const d of ["img", "fonts"]) cpSync(join(src, d), join(out, d), { recursive: true });
console.log(`Website: ${readdirSync(out).length} Dateien in ${out}`);
