#!/usr/bin/env node
/**
 * Get back the PDFs on a Cloudinary cloud we can no longer administer.
 *
 * ── The situation ─────────────────────────────────────────────────────────
 *
 * Every asset the dashboard has stored lives on djpyy3s9u, an account nobody
 * still has credentials for. PDF delivery is disabled there, so all 37 stored
 * PDFs answer 401 `deny or ACL failure`, and the setting that would lift it is
 * a console toggle on an account we cannot log into. The Admin API refuses our
 * key outright ("cloud_name mismatch"), so signed URLs are out too.
 *
 * ── The way through, for some of them ─────────────────────────────────────
 *
 * The restriction is on delivering a PDF, not on reading the asset. A PDF
 * uploaded as resource_type `image` can be RENDERED — ask for the same
 * public_id with a .jpg extension and Cloudinary rasterises page 1 and serves
 * an image. An image is not a PDF, so the block does not apply:
 *
 *     /image/upload/v123/soroman/expenses/abc.pdf   401 deny or ACL failure
 *     /image/upload/pg_1/v123/soroman/expenses/abc.jpg   200 image/jpeg
 *
 * So the file comes back a page at a time, and this stitches the pages into a
 * real PDF again. `dn_300` renders at 300 dpi, which is legible for receipts
 * and invoices — enough to read, file and audit.
 *
 * ── What this CANNOT get back ─────────────────────────────────────────────
 *
 * 28 of the 37 were uploaded as resource_type `raw`. Raw assets are bytes on a
 * shelf: no transformations, no rasterising, nothing to ask for but the file
 * itself, which is blocked. `image/fetch` against them fails too — that
 * account has fetch restricted as well. Those 28 are recoverable only by
 * regaining the djpyy3s9u login, or by the person who uploaded each one
 * sending the original again. This script lists them so you know exactly who
 * to ask for what.
 *
 * ── What you get back is a faithful RENDER, not the original bytes ────────
 *
 * The pages are images of the pages. They read identically and print
 * identically, but the text is no longer selectable and any embedded metadata
 * is gone. For a receipt or an invoice that is usually the whole of what
 * matters; if one of these is a legal original, treat this as a working copy
 * and keep chasing the account.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/recover-blocked-cloudinary-pdfs.js              # report
 *   node scripts/recover-blocked-cloudinary-pdfs.js --out=./recovered
 *   node scripts/recover-blocked-cloudinary-pdfs.js --out=./recovered --dpi=300
 *
 * Reads the database to find them and writes files to --out. It changes
 * nothing: no database write, no upload, no Cloudinary call but a GET.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const { Client } = require("pg");

const arg = (n) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : null;
};
const OUT = arg("out");
const DPI = Number(arg("dpi") || 300);

/** GET a URL whole, as a Buffer. */
function fetchBuf(url) {
  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks),
            cldError: res.headers["x-cld-error"] || "",
          })
        );
      })
      .on("error", (e) => resolve({ status: 0, body: Buffer.alloc(0), cldError: e.message }));
  });
}

function parseUrl(url) {
  const m = String(url).match(
    /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw)\/upload\/(?:v(\d+)\/)?(.+)$/
  );
  if (!m) return null;
  const [, cloud, resourceType, version, tail] = m;
  return {
    cloud,
    resourceType,
    version,
    publicId: resourceType === "raw" ? tail : tail.replace(/\.[^./]+$/, ""),
  };
}

const renderUrl = (p, page, dpi) =>
  `https://res.cloudinary.com/${p.cloud}/image/upload/pg_${page},dn_${dpi},f_jpg,q_90/` +
  `${p.version ? "v" + p.version + "/" : ""}${p.publicId}.jpg`;

/**
 * How many pages the document has.
 *
 * Cloudinary names the number in its own error when you overshoot — "Image
 * only has 3 pages and page 999 requested" — so one deliberately silly request
 * answers it exactly, rather than walking up page by page.
 */
async function pageCount(p) {
  const r = await fetchBuf(renderUrl(p, 999, 72));
  const m = /only has (\d+) pages/i.exec(r.cldError || "");
  if (m) return Number(m[1]);
  return r.status === 200 ? 1 : 0;
}

/**
 * Width, height and colour channels of a JPEG, from its SOF marker.
 *
 * Needed because a PDF has to declare the pixel dimensions of an image it
 * embeds, and we are embedding the JPEG bytes untouched.
 */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // SOF0..SOF15 carry the frame header; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), channels: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Wrap JPEG pages into a PDF, one page each.
 *
 * The JPEGs go in as-is under /DCTDecode — a PDF can carry JPEG data natively,
 * so nothing is re-encoded and no quality is lost beyond the render itself.
 * Pages are laid out at A4 width with the image's own aspect ratio, so a
 * 300 dpi render prints at its proper size instead of a page metres wide.
 */
function buildPdf(jpegs) {
  const A4_W = 595.28;
  const chunks = [];
  let len = 0;
  const push = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "binary"); chunks.push(b); len += b.length; };

  const offsets = [0];
  const obj = (num, body, stream) => {
    offsets[num] = len;
    push(`${num} 0 obj\n${body}\n`);
    if (stream) { push("stream\n"); push(stream); push("\nendstream\n"); }
    push("endobj\n");
  };

  const n = jpegs.length;
  // 1 catalog, 2 pages tree, then per page: page, contents, image.
  const pageIds = jpegs.map((_, i) => 3 + i * 3);

  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`);

  jpegs.forEach((jpg, i) => {
    const size = jpegSize(jpg) || { width: 1240, height: 1754, channels: 3 };
    const w = A4_W;
    const h = Math.round((A4_W * size.height) / size.width * 100) / 100;
    const pageId = 3 + i * 3, contentId = pageId + 1, imgId = pageId + 2;

    obj(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(contentId, `<< /Length ${content.length} >>`, content);
    obj(
      imgId,
      `<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} ` +
        `/ColorSpace ${size.channels === 1 ? "/DeviceGray" : "/DeviceRGB"} /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${jpg.length} >>`,
      jpg
    );
  });

  const xrefAt = len;
  const total = 3 + n * 3;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

const safeName = (s, fallback) =>
  (String(s || "").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim() || fallback).slice(0, 80);

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let rows;
  try {
    ({ rows } = await client.query(`
      SELECT 'expense' AS src, a.id::text AS id, a.storage_key AS url, a.file_name,
             a.expense_id::text AS ref, a.uploaded_at::date AS on_date,
             COALESCE(s.first_name || ' ' || s.surname, '—') AS who
        FROM pfi_expense_attachments a
        LEFT JOIN staff s ON s.id = a.uploaded_by
       WHERE a.storage_key ILIKE '%.pdf'
       UNION ALL
      SELECT 'license', id::text, license_url, 'licence.pdf', customer_id::text,
             created_at::date, '—'
        FROM customer_licenses WHERE license_url ILIKE '%.pdf'`));
  } finally {
    await client.end();
  }

  const items = rows.map((r) => ({ ...r, parsed: parseUrl(r.url) })).filter((r) => r.parsed);
  const renderable = items.filter((r) => r.parsed.resourceType === "image");
  const stuck = items.filter((r) => r.parsed.resourceType === "raw");

  console.log(`PDFs on record: ${items.length}`);
  console.log(`  recoverable by rendering (image type): ${renderable.length}`);
  console.log(`  NOT recoverable here (raw type)      : ${stuck.length}\n`);

  if (stuck.length) {
    console.log("── Ask these people for the original file ──");
    const byWho = {};
    for (const s of stuck) (byWho[s.who] ||= []).push(s);
    for (const [who, list] of Object.entries(byWho).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${who} — ${list.length} file(s)`);
      for (const s of list) {
        console.log(`     ${s.src} ${s.id}  ${String(s.on_date).slice(0, 10)}  ${s.file_name}`);
      }
    }
    console.log("");
  }

  if (!OUT) {
    console.log("No --out given, so nothing was downloaded. Re-run with --out=./recovered");
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  let saved = 0;
  const failed = [];

  for (const [i, r] of renderable.entries()) {
    const tag = `[${i + 1}/${renderable.length}] ${r.src} ${r.id}`;
    try {
      const pages = await pageCount(r.parsed);
      if (!pages) { failed.push({ ...r, why: "could not read a page" }); console.log(`${tag}  ✗ unreadable`); continue; }

      const jpegs = [];
      for (let p = 1; p <= pages; p++) {
        const got = await fetchBuf(renderUrl(r.parsed, p, DPI));
        if (got.status !== 200) throw new Error(`page ${p}: ${got.status} ${got.cldError}`);
        jpegs.push(got.body);
      }

      const base = safeName(r.file_name.replace(/\.pdf$/i, ""), `${r.src}-${r.id}`);
      const file = path.join(OUT, `${r.src}-${r.id} ${base}.pdf`);
      fs.writeFileSync(file, buildPdf(jpegs));
      saved++;
      console.log(`${tag}  ✓ ${pages} page(s) → ${path.basename(file)}`);
    } catch (err) {
      failed.push({ ...r, why: err.message });
      console.log(`${tag}  ✗ ${err.message}`);
    }
  }

  fs.writeFileSync(
    path.join(OUT, "_unrecoverable.json"),
    JSON.stringify(
      {
        note: "Raw-type PDFs on djpyy3s9u. Not recoverable without that account, or the original file from the uploader.",
        files: stuck.map((s) => ({
          src: s.src, id: s.id, ref: s.ref, fileName: s.file_name,
          uploadedBy: s.who, uploadedOn: String(s.on_date).slice(0, 10), url: s.url,
        })),
      },
      null,
      2
    )
  );

  console.log(`\nRecovered ${saved} of ${renderable.length} into ${OUT}`);
  console.log(`Still missing: ${stuck.length} raw PDFs — listed in ${path.join(OUT, "_unrecoverable.json")}`);
  if (failed.length) for (const f of failed) console.log(`  failed: ${f.src} ${f.id} — ${f.why}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exitCode = 1; });
}

module.exports = { parseUrl, jpegSize, buildPdf, renderUrl };
