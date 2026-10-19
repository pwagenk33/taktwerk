import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config";
import type { Branding } from "../db/schema";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Mails sent so far; only kept by the in-memory transport (tests, no SMTP configured). */
  readonly outbox: Mail[];
}

/** SMTP when SMTP_HOST is set; otherwise mails are logged and kept in memory (development, tests). */
export function createMailer(config: Config, log: (msg: string) => void = console.log): Mailer {
  const outbox: Mail[] = [];
  let transport: Transporter | null = null;
  if (config.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE === "true",
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    });
  }
  return {
    outbox,
    async send(mail) {
      if (transport) {
        await transport.sendMail({ from: config.SMTP_FROM, ...mail });
        return;
      }
      outbox.push(mail);
      log(`[mail] an ${mail.to}: ${mail.subject}\n${mail.text}`);
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Simple branded e-mail, optionally with one call-to-action button. */
export function actionMail(branding: Branding, o: { to: string; subject: string; greeting: string; lines: string[]; action?: string; url?: string; footer: string }): Mail {
  const cta = o.action && o.url ? { action: o.action, url: o.url } : null;
  const text = [o.greeting, "", ...o.lines, "", ...(cta ? [`${cta.action}: ${cta.url}`, ""] : []), o.footer, "", `– ${branding.appName}`].join("\n");
  const html = `<!doctype html><html lang="de"><body style="margin:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif;color:#1d1d1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${esc(branding.primaryColor)};padding:18px 28px;color:#ffffff;font-size:18px;font-weight:bold">${esc(branding.appName)}</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 16px">${esc(o.greeting)}</p>
${o.lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join("")}
${cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:${esc(branding.primaryColor)};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:bold">${esc(cta.action)}</a></p>` : ""}
<p style="margin:${cta ? 0 : "16px 0 0"};color:#6e6e73;font-size:13px;line-height:1.5">${esc(o.footer)}${cta ? `<br>Link funktioniert nicht? ${esc(cta.url)}` : ""}</p>
</td></tr></table></td></tr></table></body></html>`;
  return { to: o.to, subject: o.subject, text, html };
}
