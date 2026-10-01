/**
 * The email design system — every email Soroman sends is built here.
 *
 * One builder, documentEmail(), takes a subject, an optional hero band, a
 * heading and a list of blocks, and returns the HTML, the plain-text part and
 * the subject together. The notification catalog and the transactional
 * documents in services/email.service.js (invoice, ticket, Dangote and LPG
 * notices) all go through it, so a customer's inbox holds one product, not
 * the three visibly different families it used to.
 *
 * The look is the website's: emerald-700 (#007a55) as the brand ink, Satoshi
 * as the face, the logo on white. Nothing is set heavier than semibold (600):
 * at email sizes, bold Satoshi reads as shouting. Satoshi loads from Fontshare
 * where the client allows web fonts (Apple Mail, iOS, Outlook for Mac,
 * Samsung); Gmail and Outlook for Windows strip them and fall back to the
 * system sans, which is why the stack below is ordered the way it is.
 *
 * The daily report emails (dailyReportEmail, pfiDailyReportEmail) are the one
 * exception, on purpose: they are wide black-and-white data sheets whose own
 * rules are documented in reportTable.js.
 */

const { supportPhones, companyName, companyLongName } = require("../../config/brand");

const BRAND = {
  name: "Soroman",
  accent: "#007a55", // --primary on the website
  pageBg: "#f3f5f4",
  cardBg: "#ffffff",
  heading: "#0f1a14",
  text: "#44504a",
  muted: "#8a948f",
  border: "#e6eae8",
  subtleBg: "#f8faf9",
  font: "'Satoshi','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif",
};

/**
 * The states an email can open on. Each has its icon (served by the website,
 * see assetUrl) and the tint of the band it sits in. Green for anything done
 * or under way, amber for "you need to act", red for "this did not happen".
 */
const TONES = {
  success: { icon: "check-circle", ink: BRAND.accent, bg: "#f0f9f4", line: "#dcefe4", glyph: "&#10003;" },
  pending: { icon: "clock-circle", ink: BRAND.accent, bg: "#f0f9f4", line: "#dcefe4", glyph: "&#8226;" },
  info: { icon: "info-circle", ink: BRAND.accent, bg: "#f0f9f4", line: "#dcefe4", glyph: "i" },
  warning: { icon: "alert-circle", ink: "#b45309", bg: "#fffbeb", line: "#fdecc8", glyph: "!" },
  danger: { icon: "x-circle", ink: "#b91c1c", bg: "#fef2f2", line: "#fbdada", glyph: "&#215;" },
};

// The variable cut (300–900), so semibold is a real 600 and not a faked bold.
const FONT_CSS = "https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap";

/**
 * Images the emails show, served by the website (soroman-web/public) so the
 * logo can never drift from the site's. "" when no portal URL is configured,
 * and each caller has a text fallback for that case.
 */
const assetUrl = (path) => {
  const base = String(process.env.PORTAL_URL || process.env.CLIENT_URL || "").replace(/\/+$/, "");
  return base ? `${base}${path}` : "";
};
const logoUrl = () => assetUrl("/logo-full.png");

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/** ₦ amounts, matching the formatting used across the existing templates. */
function formatMoney(amount, { decimals = 2 } = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: decimals,
  }).format(n);
}

function formatQuantity(value, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

function formatDate(value, { withTime = false } = {}) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

/** "30 September 2026" in Lagos time — a server on UTC would date a late-evening event to the next day. */
function lagosDate(value = Date.now()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

const hasValue = (v) => v !== undefined && v !== null && String(v).trim() !== "";

// ─── Blocks ─────────────────────────────────────────────────────────────────

/** A small uppercase label that opens a section ("Receipt", "What happens next"). */
function sectionTitle(text) {
  return `<p style="margin:0 0 12px;color:${BRAND.muted};font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(text)}</p>`;
}

/** Body copy. `html` is trusted markup from a template; `text` is escaped here. */
function paragraph({ text, html, last = false }) {
  const body = html ?? escapeHtml(text);
  return `<p style="margin:0 0 ${last ? 32 : 18}px;color:${BRAND.text};font-size:16px;line-height:1.65;">${body}</p>`;
}

/** A reference or name set in body copy: same size, heading colour, semibold. */
const em = (value) => `<span style="color:${BRAND.heading};font-weight:600;">${escapeHtml(value)}</span>`;

/**
 * The band an email opens with, edge to edge under the logo: an icon for the
 * state, what happened, an optional figure in large type, one line of context.
 */
function hero({ tone = "success", label, value = "", caption = "" }) {
  const t = TONES[tone] || TONES.success;
  const icon = assetUrl(`/email/${t.icon}.png`);
  return `
            <tr>
              <td class="pad" align="center" style="padding:44px 44px 40px;background-color:${t.bg};border-top:1px solid ${t.line};border-bottom:1px solid ${t.line};text-align:center;">
                ${
                  // An image, not a character: mail clients draw ✓ and friends
                  // from whatever font they have, and on Apple devices a tick
                  // comes out looking like a square-root sign.
                  icon
                    ? `<img src="${escapeHtml(icon)}" width="52" height="52" alt="" style="display:block;margin:0 auto;width:52px;height:52px;border:0;outline:none;">`
                    : `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td width="52" height="52" align="center" valign="middle" bgcolor="${t.ink}" style="width:52px;height:52px;border-radius:26px;background-color:${t.ink};color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:52px;text-align:center;">${t.glyph}</td></tr></table>`
                }
                ${
                  value
                    ? `<p style="margin:20px 0 10px;color:${t.ink};font-size:15px;font-weight:600;">${escapeHtml(label)}</p>
                <p class="amount" style="margin:0;color:${BRAND.heading};font-size:42px;font-weight:600;line-height:1.1;letter-spacing:-0.02em;">${escapeHtml(value)}</p>`
                    : `<p class="hero-title" style="margin:20px 0 0;color:${BRAND.heading};font-size:26px;font-weight:600;line-height:1.25;letter-spacing:-0.01em;">${escapeHtml(label)}</p>`
                }
                ${caption ? `<p style="margin:12px 0 0;color:${BRAND.text};font-size:14px;line-height:1.5;">${escapeHtml(caption)}</p>` : ""}
              </td>
            </tr>`;
}

/**
 * A boxed table of label/value rows, optionally closed by a total line.
 * Empty values are dropped — an order without a depot shows no "Depot" row
 * rather than "Depot —". `strong` rows are set in semibold.
 */
function table({ title = "", rows = [], total = null }) {
  const visible = rows.filter((r) => r && hasValue(r.value));
  if (!visible.length && !total) return "";

  const rule = `border-bottom:1px solid ${BRAND.border};`;
  const cells = visible
    .map(({ label, value, strong }, i) => {
      const line = i < visible.length - 1 || total ? rule : "";
      return `
          <tr>
            <td style="padding:14px 0;${line}color:${BRAND.muted};font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
            <td style="padding:14px 0 14px 16px;${line}text-align:right;color:${BRAND.heading};font-size:14px;font-weight:${strong ? 600 : 500};vertical-align:top;">${escapeHtml(value)}</td>
          </tr>`;
    })
    .join("");
  const totalRow =
    total && hasValue(total.value)
      ? `
          <tr>
            <td style="padding:18px 0 16px;color:${BRAND.heading};font-size:15px;font-weight:600;">${escapeHtml(total.label)}</td>
            <td style="padding:18px 0 16px 16px;text-align:right;color:${BRAND.heading};font-size:16px;font-weight:600;white-space:nowrap;">${escapeHtml(total.value)}</td>
          </tr>`
      : "";

  return `
    ${title ? sectionTitle(title) : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;background-color:${BRAND.subtleBg};border:1px solid ${BRAND.border};border-radius:14px;">
      <tr><td style="padding:4px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cells}${totalRow}</table>
      </td></tr>
    </table>`;
}

/**
 * Where to send the money: the account number set large enough to copy
 * without squinting, the bank and account name under it, and the amount.
 * Renders nothing without an account number — a box telling a customer to pay
 * into "N/A" is worse than no box.
 */
function payTo({ title = "Pay to", accountNumber, bank, accountName, amount, amountLabel = "Amount to pay" }) {
  if (!hasValue(accountNumber)) return "";
  const t = TONES.success;
  const row = (label, value, strong) =>
    hasValue(value)
      ? `<tr>
            <td style="padding:10px 0 0;color:${BRAND.muted};font-size:14px;white-space:nowrap;">${escapeHtml(label)}</td>
            <td style="padding:10px 0 0 16px;text-align:right;color:${BRAND.heading};font-size:${strong ? 16 : 14}px;font-weight:${strong ? 600 : 500};">${escapeHtml(value)}</td>
          </tr>`
      : "";
  return `
    ${sectionTitle(title)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;background-color:${t.bg};border:1px solid ${t.line};border-radius:14px;">
      <tr><td style="padding:22px 24px 20px;">
        <p style="margin:0 0 4px;color:${BRAND.muted};font-size:13px;">Account number</p>
        <p class="acct" style="margin:0 0 8px;color:${BRAND.heading};font-size:30px;font-weight:600;letter-spacing:0.06em;line-height:1.2;">${escapeHtml(accountNumber)}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${t.line};">
          ${row("Bank", bank)}
          ${row("Account name", accountName)}
          ${row(amountLabel, amount, true)}
        </table>
      </td></tr>
    </table>`;
}

/** A tinted note. `tone` picks the palette; the copy is the caller's. */
function callout({ tone = "info", title = "", text }) {
  const t = TONES[tone] || TONES.info;
  const neutral = tone === "info" || tone === "success" || tone === "pending";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;background-color:${neutral ? BRAND.subtleBg : t.bg};border:1px solid ${neutral ? BRAND.border : t.line};border-radius:12px;">
      <tr><td style="padding:16px 20px;color:${BRAND.text};font-size:14px;line-height:1.6;">
        ${title ? `<span style="display:block;margin-bottom:4px;color:${neutral ? BRAND.heading : t.ink};font-size:15px;font-weight:600;">${escapeHtml(title)}</span>` : ""}${escapeHtml(text)}
      </td></tr>
    </table>`;
}

/**
 * The call to action: a full-width, bulletproof button (a table cell, so it
 * keeps its shape in Outlook), in medium weight.
 */
function callToAction(url, label) {
  if (!url) return "";
  const safeUrl = escapeHtml(url);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 36px;">
      <tr>
        <td align="center" bgcolor="${BRAND.accent}" style="background-color:${BRAND.accent};border-radius:12px;box-shadow:0 8px 20px -6px rgba(0,122,85,0.45);">
          <a href="${safeUrl}" target="_blank" style="display:block;padding:18px 24px;font-family:${BRAND.font};color:#ffffff;font-size:16px;font-weight:500;line-height:20px;text-align:center;text-decoration:none;letter-spacing:0.01em;border-radius:12px;">
            ${escapeHtml(label)}&nbsp;&nbsp;&rarr;
          </a>
        </td>
      </tr>
    </table>`;
}

/**
 * "Need help?" over tap-to-call numbers, set off by a rule. "" when no numbers
 * are configured — never a heading with nothing under it.
 */
function contactLine({ lead = "Need help?", phones = supportPhones() } = {}) {
  const list = phones.filter(Boolean);
  if (!list.length) return "";
  const links = list
    .map(
      (p) =>
        `<a href="tel:${escapeHtml(p.replace(/[^\d+]/g, ""))}" style="color:${BRAND.accent};text-decoration:none;font-weight:500;white-space:nowrap;">${escapeHtml(p)}</a>`
    )
    .join(`<span style="color:${BRAND.muted};">&nbsp; &middot; &nbsp;</span>`);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;border-top:1px solid ${BRAND.border};">
      <tr><td style="padding-top:28px;">
        <p style="margin:0 0 4px;color:${BRAND.heading};font-size:15px;font-weight:600;">${escapeHtml(lead)}</p>
        <p style="margin:0;color:${BRAND.text};font-size:14px;line-height:1.8;">Call us on ${links}</p>
      </td></tr>
    </table>`;
}

/** "Thank you for choosing Soroman, / Soroman Energy" — or the caller's lines. */
function signOff({ lines } = {}) {
  const [first, second] = lines || [`Thank you for choosing ${companyName()},`, companyLongName()];
  return paragraph({
    html: `${escapeHtml(first)}${second ? `<br><span style="color:${BRAND.heading};font-weight:600;">${escapeHtml(second)}</span>` : ""}`,
    last: true,
  });
}

// ─── The shell ──────────────────────────────────────────────────────────────

/**
 * Wrap body HTML in the branded shell: logo and label on white, an optional
 * hero band, the body, and a copyright line under the card.
 *
 * @param {object} opts
 * @param {string} opts.subtitle  the label opposite the logo ("Payment receipt")
 * @param {string} opts.preheader the inbox preview line; hidden in the body
 * @param {string} opts.heroHtml  a full-width band under the logo (hero())
 * @param {string} opts.heading   the headline inside the card
 * @param {string} opts.bodyHtml  pre-rendered blocks
 */
function layout({ subtitle = "", preheader = "", heroHtml = "", heading = "", bodyHtml = "" } = {}) {
  const logo = logoUrl();
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <link href="${FONT_CSS}" rel="stylesheet">
    <style>
      body, table, td, p, a { font-family: ${BRAND.font}; }
      @media (max-width: 620px) {
        .shell { padding: 16px 10px !important; }
        .pad { padding-left: 24px !important; padding-right: 24px !important; }
        .headline { font-size: 24px !important; }
        .amount { font-size: 34px !important; }
        .hero-title { font-size: 22px !important; }
        .acct { font-size: 26px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:${BRAND.pageBg};font-family:${BRAND.font};-webkit-font-smoothing:antialiased;">
    ${
      // Gmail and Apple Mail show the first text in the body as the inbox
      // preview; without this it is the alt text of the logo.
      preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>`
        : ""
    }
    <table role="presentation" class="shell" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.pageBg};padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:${BRAND.cardBg};border-radius:18px;overflow:hidden;border:1px solid ${BRAND.border};">
            <tr>
              <td class="pad" style="padding:28px 44px ${heroHtml ? "28px" : "0"};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      ${
                        logo
                          ? `<img src="${escapeHtml(logo)}" width="132" height="24" alt="${BRAND.name}" style="display:block;width:132px;height:24px;border:0;outline:none;">`
                          : `<span style="color:${BRAND.heading};font-size:22px;font-weight:600;letter-spacing:-0.02em;">${BRAND.name}</span>`
                      }
                    </td>
                    ${subtitle ? `<td style="vertical-align:middle;text-align:right;color:${BRAND.muted};font-size:13px;font-weight:500;">${escapeHtml(subtitle)}</td>` : ""}
                  </tr>
                </table>
              </td>
            </tr>
            ${heroHtml}
            <tr>
              <td class="pad" style="padding:${heroHtml ? "36px" : "40px"} 44px 4px;">
                ${heading ? `<h1 class="headline" style="margin:0 0 18px;color:${BRAND.heading};font-size:28px;font-weight:600;line-height:1.25;letter-spacing:-0.02em;">${escapeHtml(heading)}</h1>` : ""}
                ${bodyHtml}
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
            <tr>
              <td class="pad" style="padding:24px 44px 8px;text-align:center;color:${BRAND.muted};font-size:12px;line-height:1.7;">
                <p style="margin:0;">&copy; ${new Date().getFullYear()} ${escapeHtml(companyLongName())}. All rights reserved.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ─── The builder ────────────────────────────────────────────────────────────

/**
 * Render one block to HTML and to plain text. Blocks:
 *
 *   { type: "text", text | html, plain? }   body copy (plain: text for html blocks)
 *   { type: "table", title, rows, total }    boxed label/value rows
 *   { type: "payTo", title, accountNumber, bank, accountName, amount, amountLabel }
 *   { type: "next", title?, text }           "What happens next" + one paragraph
 *   { type: "note", tone, title?, text }     tinted note
 *   { type: "button", url, label }
 *   { type: "help", lead? }                  support numbers
 *   { type: "signoff", lines? }
 *
 * Falsy entries are skipped, so a template can write `cond && {...}`.
 */
function renderBlock(b) {
  switch (b.type) {
    case "text": {
      const plain = b.plain ?? b.text ?? "";
      return { html: paragraph({ text: b.text, html: b.html, last: b.last }), text: plain };
    }
    case "table": {
      const rows = (b.rows || []).filter((r) => r && hasValue(r.value));
      const lines = [
        b.title ? b.title.toUpperCase() : null,
        ...rows.map((r) => `${r.label}: ${r.value}`),
        b.total && hasValue(b.total.value) ? `${b.total.label}: ${b.total.value}` : null,
      ].filter(Boolean);
      return { html: table(b), text: lines.join("\n") };
    }
    case "payTo": {
      if (!hasValue(b.accountNumber)) return { html: "", text: "" };
      const lines = [
        (b.title || "Pay to").toUpperCase(),
        `Account number: ${b.accountNumber}`,
        hasValue(b.bank) ? `Bank: ${b.bank}` : null,
        hasValue(b.accountName) ? `Account name: ${b.accountName}` : null,
        hasValue(b.amount) ? `${b.amountLabel || "Amount to pay"}: ${b.amount}` : null,
      ].filter(Boolean);
      return { html: payTo(b), text: lines.join("\n") };
    }
    case "next": {
      const title = b.title || "What happens next";
      return {
        html: sectionTitle(title) + paragraph({ text: b.text, last: true }),
        text: `${title.toUpperCase()}\n${b.text}`,
      };
    }
    case "note":
      return {
        html: callout(b),
        text: b.title ? `${b.title}: ${b.text}` : b.text,
      };
    case "button":
      return b.url ? { html: callToAction(b.url, b.label), text: `${b.label}: ${b.url}` } : { html: "", text: "" };
    case "help": {
      const phones = supportPhones();
      const lead = b.lead || "Need help?";
      return {
        html: contactLine({ lead }),
        text: phones.length ? `${lead} Call us on ${phones.join(" · ")}` : "",
      };
    }
    case "signoff": {
      const lines = b.lines || [`Thank you for choosing ${companyName()},`, companyLongName()];
      return { html: signOff({ lines }), text: lines.filter(Boolean).join("\n") };
    }
    default:
      return { html: "", text: "" };
  }
}

/**
 * Build a complete email.
 *
 * @param {object} spec
 * @param {string} spec.subject
 * @param {string} [spec.subtitle]   label opposite the logo
 * @param {string} [spec.preheader]  inbox preview line
 * @param {object} [spec.hero]       { tone, label, value?, caption? }
 * @param {string} [spec.heading]
 * @param {Array}  [spec.blocks]     see renderBlock
 * @returns {{ subject: string, html: string, text: string }}
 */
function documentEmail({ subject, subtitle = "", preheader = "", hero: heroSpec, heading = "", blocks = [] }) {
  const rendered = blocks.filter(Boolean).map(renderBlock);
  const html = layout({
    subtitle,
    preheader,
    heroHtml: heroSpec ? hero(heroSpec) : "",
    heading,
    bodyHtml: rendered.map((r) => r.html).join(""),
  });

  const heroLines = heroSpec
    ? [heroSpec.value ? `${heroSpec.label}: ${heroSpec.value}` : heroSpec.label, heroSpec.caption]
    : [];
  const text = [...heroLines, "", heading, "", ...rendered.flatMap((r) => (r.text ? [r.text, ""] : []))]
    .filter((line) => line !== undefined && line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { subject, html, text };
}

module.exports = {
  BRAND,
  escapeHtml,
  em,
  formatMoney,
  formatQuantity,
  formatDate,
  lagosDate,
  layout,
  documentEmail,
};
