/**
 * The shared branded email shell.
 *
 * services/email.service.js hand-rolls a full HTML document per template, which
 * is why the eight templates there run to 1,200 lines and drifted in their
 * footers and paddings. Those templates stay exactly as they are — they are
 * transactional documents (an invoice, a QR ticket) whose layout is the point,
 * and rewriting them would risk the copy customers already receive.
 *
 * Everything the notification engine generates instead renders through the
 * layout below: one look, one footer, one place to change either.
 *
 * The look is the website's: emerald-700 (#007a55) as the brand ink, Satoshi
 * as the face, the logo on white. Nothing is set heavier than semibold (600):
 * at email sizes, bold Satoshi reads as shouting. Satoshi loads from Fontshare where the mail
 * client allows web fonts (Apple Mail, iOS, Outlook for Mac, Samsung); Gmail
 * and Outlook for Windows strip them and fall back to the system sans, which is
 * why the stack below is ordered the way it is.
 */

const BRAND = {
  name: "Soroman",
  accent: "#007a55", // --primary on the website
  accentDark: "#00613f",
  accentTint: "#ecfdf5",
  accentLine: "#a7f3d0",
  pageBg: "#f3f5f4",
  cardBg: "#ffffff",
  heading: "#0f1a14",
  text: "#44504a",
  muted: "#8a948f",
  border: "#e6eae8",
  subtleBg: "#f8faf9",
  heroBg: "#f0f9f4",
  heroLine: "#dcefe4",
  font: "'Satoshi','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif",
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

/**
 * A label/value table. Rows whose value is empty are dropped rather than
 * rendered blank — a notification about an order without a depot should not
 * show "Depot —".
 */
function detailRows(rows = [], { title = "" } = {}) {
  const visible = rows.filter(
    (r) => r && r.value !== undefined && r.value !== null && String(r.value).trim() !== ""
  );
  if (!visible.length) return "";

  const cells = visible
    .map(
      ({ label, value, strong }, i) => `
        <tr>
          <td style="padding:12px 0;${i < visible.length - 1 ? `border-bottom:1px solid ${BRAND.border};` : ""}color:${BRAND.muted};font-size:14px;">${escapeHtml(label)}</td>
          <td style="padding:12px 0;${i < visible.length - 1 ? `border-bottom:1px solid ${BRAND.border};` : ""}text-align:right;color:${strong ? BRAND.accent : BRAND.heading};font-size:14px;font-weight:${strong ? 600 : 500};">${escapeHtml(value)}</td>
        </tr>`
    )
    .join("");

  return `
    ${title ? sectionTitle(title) : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;border-top:1px solid ${BRAND.border};border-bottom:1px solid ${BRAND.border};">${cells}</table>`;
}

/** A small uppercase label that opens a section ("Order summary"). */
function sectionTitle(text) {
  return `<p style="margin:0 0 12px;color:${BRAND.muted};font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;">${escapeHtml(text)}</p>`;
}

/**
 * The call to action: a full-width, bulletproof button (a table cell, so it
 * keeps its shape in Outlook), with an optional muted line centred under it —
 * what the reader will meet on the other side ("you'll be asked to sign in").
 */
function callToAction(url, label, { hint = "" } = {}) {
  if (!url) return "";
  const safeUrl = escapeHtml(url);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 ${hint ? "14px" : "36px"};">
      <tr>
        <td align="center" bgcolor="${BRAND.accent}" style="background-color:${BRAND.accent};border-radius:12px;box-shadow:0 8px 20px -6px rgba(0,122,85,0.45);">
          <a href="${safeUrl}" target="_blank" style="display:block;padding:18px 24px;font-family:${BRAND.font};color:#ffffff;font-size:16px;font-weight:500;line-height:20px;text-align:center;text-decoration:none;letter-spacing:0.01em;border-radius:12px;">
            ${escapeHtml(label)}&nbsp;&nbsp;&rarr;
          </a>
        </td>
      </tr>
    </table>
    ${hint ? `<p style="margin:0 0 36px;color:${BRAND.muted};font-size:13px;line-height:1.5;text-align:center;">${escapeHtml(hint)}</p>` : ""}`;
}

/**
 * The band a receipt opens with, edge to edge under the logo: a tick, what
 * happened, the amount in large type and one line of context. Passed to
 * layout() as `hero`, so it sits outside the padded body.
 */
function receiptHero({ label, amount, caption = "", icon = assetUrl("/email/check-circle.png") }) {
  if (!amount) return "";
  return `
            <tr>
              <td class="pad" align="center" style="padding:44px 44px 40px;background-color:${BRAND.heroBg};border-top:1px solid ${BRAND.heroLine};border-bottom:1px solid ${BRAND.heroLine};text-align:center;">
                ${
                  // An image, not the ✓ character: mail clients draw that glyph
                  // from whatever font they have, and on Apple devices it comes
                  // out looking like a square-root sign.
                  icon
                    ? `<img src="${escapeHtml(icon)}" width="52" height="52" alt="" style="display:block;margin:0 auto;width:52px;height:52px;border:0;outline:none;">`
                    : `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td width="52" height="52" align="center" valign="middle" bgcolor="${BRAND.accent}" style="width:52px;height:52px;border-radius:26px;background-color:${BRAND.accent};color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:52px;text-align:center;">&#10003;</td></tr></table>`
                }
                <p style="margin:20px 0 10px;color:${BRAND.accent};font-size:15px;font-weight:600;">${escapeHtml(label)}</p>
                <p class="amount" style="margin:0;color:${BRAND.heading};font-size:42px;font-weight:600;line-height:1.1;letter-spacing:-0.02em;">${escapeHtml(amount)}</p>
                ${caption ? `<p style="margin:12px 0 0;color:${BRAND.text};font-size:14px;line-height:1.5;">${escapeHtml(caption)}</p>` : ""}
              </td>
            </tr>`;
}

/**
 * A boxed receipt: label/value rows closed by a total line. Empty values are
 * dropped, as in detailRows.
 */
function receiptTable(rows = [], { title = "", total = null } = {}) {
  const visible = rows.filter(
    (r) => r && r.value !== undefined && r.value !== null && String(r.value).trim() !== ""
  );
  if (!visible.length && !total) return "";

  const rule = `border-bottom:1px solid ${BRAND.border};`;
  const cells = visible
    .map(({ label, value }, i) => {
      const line = i < visible.length - 1 || total ? rule : "";
      return `
          <tr>
            <td style="padding:14px 0;${line}color:${BRAND.muted};font-size:14px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
            <td style="padding:14px 0 14px 16px;${line}text-align:right;color:${BRAND.heading};font-size:14px;font-weight:500;vertical-align:top;">${escapeHtml(value)}</td>
          </tr>`;
    })
    .join("");
  const totalRow = total
    ? `
          <tr>
            <td style="padding:18px 0 16px;color:${BRAND.heading};font-size:15px;font-weight:600;">${escapeHtml(total.label)}</td>
            <td style="padding:18px 0 16px 16px;text-align:right;color:${BRAND.heading};font-size:16px;font-weight:600;white-space:nowrap;">${escapeHtml(total.value)}</td>
          </tr>`
    : "";

  return `
    ${title ? sectionTitle(title) : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 36px;background-color:${BRAND.subtleBg};border:1px solid ${BRAND.border};border-radius:14px;">
      <tr><td style="padding:4px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cells}${totalRow}</table>
      </td></tr>
    </table>`;
}

/** A tinted callout. `tone` picks the palette; the copy is the caller's. */
function callout(html, tone = "info") {
  const tones = {
    info: { bg: BRAND.subtleBg, bar: BRAND.accent, text: BRAND.text },
    warning: { bg: "#fffbeb", bar: "#d97706", text: "#78350f" },
    danger: { bg: "#fef2f2", bar: "#dc2626", text: "#7f1d1d" },
  };
  const t = tones[tone] || tones.info;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;background-color:${t.bg};border-left:3px solid ${t.bar};border-radius:0 10px 10px 0;">
      <tr><td style="padding:16px 20px;color:${t.text};font-size:14px;line-height:1.6;">${html}</td></tr>
    </table>`;
}

/**
 * "Need help?" over tap-to-call numbers, set off by a rule. "" when no numbers
 * are configured — never a heading with nothing under it.
 */
function contactLine(phones = [], { lead = "Need help?" } = {}) {
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

/**
 * Wrap body HTML in the branded shell.
 *
 * @param {object}  opts
 * @param {string}  opts.subtitle  the label opposite the logo ("Payment receipt")
 * @param {string}  opts.heading   the headline inside the card
 * @param {string}  opts.intro     lead paragraph (plain text; escaped here)
 * @param {string}  opts.bodyHtml  pre-rendered blocks (detailRows, callout, …)
 * @param {string}  opts.footNote  small print closing the card
 * @param {string}  opts.preheader the inbox preview line; hidden in the body
 * @param {string}  opts.hero      a full-width band under the logo (receiptHero)
 */
function layout({
  subtitle = "",
  heading = "",
  intro = "",
  bodyHtml = "",
  footNote = "",
  preheader = "",
  hero = "",
} = {}) {
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
              <td class="pad" style="padding:28px 44px ${hero ? "28px" : "0"};">
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
            ${hero}
            <tr>
              <td class="pad" style="padding:${hero ? "36px" : "40px"} 44px 12px;">
                ${heading ? `<h1 class="headline" style="margin:0 0 20px;color:${BRAND.heading};font-size:28px;font-weight:600;line-height:1.25;letter-spacing:-0.02em;">${escapeHtml(heading)}</h1>` : ""}
                ${intro ? `<p style="margin:0 0 28px;color:${BRAND.text};font-size:16px;line-height:1.65;">${escapeHtml(intro)}</p>` : ""}
                ${bodyHtml}
                ${footNote ? `<p style="margin:0 0 32px;color:${BRAND.muted};font-size:13px;line-height:1.6;">${escapeHtml(footNote)}</p>` : ""}
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
            <tr>
              <td class="pad" style="padding:24px 44px 8px;text-align:center;color:${BRAND.muted};font-size:12px;line-height:1.7;">
                <p style="margin:0;">&copy; ${new Date().getFullYear()} ${escapeHtml(process.env.COMPANY_LONG_NAME || `${BRAND.name} Energy`)}. All rights reserved.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

module.exports = {
  BRAND,
  escapeHtml,
  formatMoney,
  formatQuantity,
  formatDate,
  detailRows,
  sectionTitle,
  callToAction,
  callout,
  receiptHero,
  receiptTable,
  contactLine,
  layout,
};
