// Builds the public website (static HTML) into website/dist.
// Pages in src/pages use small directives: <!--@head title="…" description="…"-->, <!--@header page-->, <!--@footer-->,
// <!--@plans--> (price table from packages/domain/src/plans.ts, so website and app always show the same packages)
// and <!--@markdown ../docs/AVV-Vorlage.md--> (legal templates kept in docs/).
// %APP_URL% stays in the output; the server replaces it with APP_URL when it serves a page.
// `node build.mjs --app=https://…` replaces it at build time instead (static preview without the server).
// %SITE_URL% (canonical links, sitemap, preview images) works the same way; `--site=https://…` fills it at build time.
// Search engines get a sitemap, canonical links, Open Graph tags and structured data (product with prices, FAQ).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const chf = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, "’");
const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function plansHtml() {
  const cards = PLANS.map((p) => {
    const featured = p.id === "team";
    return `<article class="plan${featured ? " featured" : ""}" aria-labelledby="plan-${p.id}">
  ${featured ? '<p class="plan-flag">Am häufigsten gewählt</p>' : ""}
  <h3 id="plan-${p.id}">${esc(p.name)}</h3>
  <p class="plan-size">${esc(p.tagline)}</p>
  <p class="plan-price"><span class="cur">CHF</span> <strong data-month="${chf(p.perUser)}" data-year="${chf(Math.round((p.perUser * 10 * 100) / 12) / 100)}">${chf(p.perUser)}</strong> <span class="per">pro Person<br>und Monat</span></p>
  <p class="plan-bill" data-month="monatlich verrechnet" data-year="CHF ${chf(p.perUser * 10)} pro Person jährlich verrechnet">monatlich verrechnet</p>
  <ul>${p.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>
  <a class="btn${featured ? " primary" : ""}" href="%APP_URL%/registrieren?paket=${p.id}">${TRIAL_DAYS} Tage testen</a>
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
function jsonLd(html) {
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
      url: "%SITE_URL%/",
      image: "%SITE_URL%/img/app-eingang.jpg",
      description: "Zeiterfassung, Spesen und Absenzen mit Budget-Forecast aus JIRA, QR-Rechnung und Daten in der Schweiz.",
      offers: PLANS.map((p) => ({ "@type": "Offer", name: p.name, price: p.perUser.toFixed(2), priceCurrency: "CHF", description: `${p.name}: pro Person und Monat` })),
      provider: { "@type": "Organization", name: "TrackInsight", url: "%SITE_URL%/" },
    },
    ...(faq.length ? [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq }] : []),
  ];
  return data.map((d) => `<script type="application/ld+json">${JSON.stringify(d).replaceAll("<", "\\u003c")}</script>`).join("\n") + "\n";
}

const partial = (name) => readFileSync(join(src, "partials", `${name}.html`), "utf8");
const NAV = [["funktionen", "Funktionen"], ["preise", "Preise"], ["sicherheit", "Sicherheit"], ["kontakt", "Kontakt"]];
const link = (page) => (page === "index" ? (preview ? "index.html" : "/") : preview ? `${page}.html` : `/${page}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pages = [];
const PAGES = new Set(readdirSync(join(src, "pages")).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")));
for (const file of readdirSync(join(src, "pages")).filter((f) => f.endsWith(".html"))) {
  const page = file.replace(/\.html$/, "");
  let html = readFileSync(join(src, "pages", file), "utf8");
  html = html.replace(/<!--@head([^>]*)-->/, (_, a) => {
    const { title, description } = attrs(a);
    return partial("head")
      .replaceAll("{{title}}", esc(title))
      .replaceAll("{{description}}", esc(description))
      .replaceAll("{{page}}", page === "index" ? "" : page)
      .replace("{{robots}}", NOINDEX.includes(page) ? '<meta name="robots" content="noindex">\n' : "")
      .replace("{{jsonld}}", page === "index" ? jsonLd(html) : "");
  });
  html = html.replace("<!--@header-->", () =>
    partial("header").replace("{{nav}}", NAV.map(([id, label]) => `<a href="${link(id)}"${id === page ? ' aria-current="page"' : ""}>${label}</a>`).join("")));
  html = html.replace("<!--@footer-->", () => partial("footer"));
  html = html.replace("<!--@plans-->", () => plansHtml());
  html = html.replace(/<!--@markdown ([^ ]+)-->/g, (_, p) => markdown(readFileSync(resolve(here, p), "utf8")));
  html = html.replace(/\{\{price\.(\w+)\}\}/g, (m, id) => { const p = PLANS.find((x) => x.id === id); return p ? chf(p.perUser) : m; });
  html = html.replaceAll("{{trialDays}}", String(TRIAL_DAYS)).replaceAll("{{minSeats}}", String(MIN_SEATS));
  html = html.replace(/href="\/(\w[\w-]*)?"/g, (m, p) => (p && PAGES.has(p) ? `href="${link(p)}"` : !p ? `href="${link("index")}"` : m));
  if (preview) html = html.replace('<html lang="de-CH">', '<html lang="de-CH" data-preview="1">').replace(/(href|src)="\/(site\.css|site\.js|favicon\.svg|img\/|fonts\/)/g, '$1="$2');
  if (appUrl) html = html.replaceAll("%APP_URL%", appUrl);
  if (siteUrl) html = html.replaceAll("%SITE_URL%", siteUrl);
  writeFileSync(join(out, file), html);
  if (!NOINDEX.includes(page)) pages.push(page);
}
// Sitemap with every listed page; the server fills in %SITE_URL% like in the pages.
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.sort().map((p) => `  <url><loc>%SITE_URL%/${p === "index" ? "" : p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`;
writeFileSync(join(out, "sitemap.xml"), siteUrl ? sitemap.replaceAll("%SITE_URL%", siteUrl) : sitemap);
const robots = readFileSync(join(src, "robots.txt"), "utf8");
writeFileSync(join(out, "robots.txt"), siteUrl ? robots.replaceAll("%SITE_URL%", siteUrl) : robots);
for (const f of ["site.css", "site.js", "favicon.svg"]) cpSync(join(src, f), join(out, f));
for (const d of ["img", "fonts"]) cpSync(join(src, d), join(out, d), { recursive: true });
console.log(`Website: ${readdirSync(out).length} Dateien in ${out}`);
