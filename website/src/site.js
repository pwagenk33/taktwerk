// Small enhancements for the static website: mobile menu, monthly/yearly prices, contact form.
(() => {
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
  if (form) {
    const msg = document.getElementById("form-msg");
    const show = (text, err) => { msg.textContent = text; msg.classList.toggle("err", !!err); msg.hidden = false; };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      // Static preview (opened as a file or outside the TrackInsight server): nothing can be sent.
      if (location.protocol === "file:" || !location.host || document.documentElement.dataset.preview === "1") {
        show("Vorschau: In dieser Demo wird nichts verschickt. Auf trackinsight.ch geht die Anfrage per E-Mail an das Team.");
        return;
      }
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const res = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Senden fehlgeschlagen");
        form.reset();
        show("Danke! Ihre Anfrage ist angekommen, wir melden uns bei Ihnen.");
      } catch (err) {
        show(`${err.message.replace(/\.$/, "")}. Bitte versuchen Sie es später nochmals oder schreiben Sie uns direkt eine E-Mail.`, true);
      } finally {
        btn.disabled = false;
      }
    });
  }
})();
