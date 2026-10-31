// Small enhancements for the static website: mobile menu, monthly/yearly prices, contact form.
(() => {
  // Recommendation or partner code from a shared link (?ref=CODE, ?partner=CODE): kept while browsing and
  // passed on to every sign-up button.
  let code = "";
  try {
    const q = new URLSearchParams(location.search);
    code = (q.get("ref") || q.get("partner") || sessionStorage.getItem("ti.code") || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
    if (code) sessionStorage.setItem("ti.code", code);
  } catch { /* storage blocked */ }
  if (code) {
    for (const a of document.querySelectorAll('a[href*="/registrieren"]')) {
      const url = new URL(a.href, location.href);
      url.searchParams.set("ref", code);
      a.href = url.toString();
    }
  }
  const menuBtn = document.getElementById("menu-btn");
  const nav = document.getElementById("main-nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
  }

  const toggle = document.querySelector(".billing-toggle");
  if (toggle) {
    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-interval]");
      if (!btn) return;
      const interval = btn.dataset.interval;
      for (const b of toggle.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
      for (const el of document.querySelectorAll("[data-month][data-year]")) el.textContent = interval === "year" ? el.dataset.year : el.dataset.month;
    });
  }

  const form = document.getElementById("contact-form");
  // Messages in the page's language (de-CH, fr-CH, it-CH).
  const TEXTS = {
    de: { preview: "Vorschau: In dieser Demo wird nichts verschickt. Auf trackinsight.ch geht die Anfrage per E-Mail an das Team.", failed: "Senden fehlgeschlagen", thanks: "Danke! Ihre Anfrage ist angekommen, wir melden uns bei Ihnen.", later: "Bitte versuchen Sie es später nochmals oder schreiben Sie uns direkt eine E-Mail." },
    fr: { preview: "Aperçu : rien n'est envoyé dans cette démo. Sur trackinsight.ch, la demande part par e-mail à l'équipe.", failed: "Échec de l'envoi", thanks: "Merci ! Votre demande est bien arrivée, nous vous recontactons.", later: "Veuillez réessayer plus tard ou nous écrire directement par e-mail." },
    it: { preview: "Anteprima: in questa demo non viene inviato nulla. Su trackinsight.ch la richiesta arriva al team via e-mail.", failed: "Invio non riuscito", thanks: "Grazie! La Sua richiesta è arrivata, La ricontatteremo.", later: "Riprovi più tardi o ci scriva direttamente un'e-mail." },
  };
  const T = TEXTS[document.documentElement.lang.slice(0, 2)] || TEXTS.de;
  if (form) {
    const msg = document.getElementById("form-msg");
    const show = (text, err) => { msg.textContent = text; msg.classList.toggle("err", !!err); msg.hidden = false; };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      // Static preview (opened as a file or outside the TrackInsight server): nothing can be sent.
      if (location.protocol === "file:" || !location.host || document.documentElement.dataset.preview === "1") {
        show(T.preview);
        return;
      }
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const res = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || T.failed);
        form.reset();
        show(T.thanks);
      } catch (err) {
        show(`${err.message.replace(/\.$/, "")}. ${T.later}`, true);
      } finally {
        btn.disabled = false;
      }
    });
  }
})();

// Calculator (rechner): revenue lost through time that is never booked. Runs only in the browser.
(() => {
  const form = document.getElementById("calc");
  if (!form) return;
  const num = (name) => Math.max(0, Number(form.elements[name].value) || 0);
  const fmt = (n) => Math.round(n).toLocaleString("de-CH").replace(/[’']/g, "’");
  const update = () => {
    const hours = (num("people") * num("minutes") * num("days")) / 60;
    const lost = hours * num("rate");
    document.getElementById("k-lost").textContent = `CHF ${fmt(lost)}`;
    document.getElementById("k-hours").textContent = `${fmt(hours)} h`;
    document.getElementById("k-pp").textContent = `CHF ${fmt(num("people") ? lost / num("people") / 12 : 0)}`;
  };
  form.addEventListener("input", update);
  form.addEventListener("submit", (e) => e.preventDefault());
  update();
})();
