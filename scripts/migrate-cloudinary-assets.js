#!/usr/bin/env node
/**
 * Move every stored Cloudinary asset from one product environment to another,
 * and repoint the database at the copies.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Every asset the dashboard has ever stored lives on ONE cloud, written there
 * between 2026-08-20 and 2026-09-17 — 94 expense attachments and 3 customer
 * licences. Railway now names a different cloud, so uploads and the stored
 * URLs no longer agree about where files belong. Cloudinary has no "move
 * between product environments" action, so this is a genuine copy-and-repoint.
 *
 * ── What it does per asset ────────────────────────────────────────────────
 *
 *   1. read the stored URL and pull the public_id, resource type and version
 *   2. upload to the TARGET cloud from the SOURCE url, keeping the public_id
 *      so the path on the new cloud is identical but for the cloud name
 *   3. fetch the new URL and require a 2xx before believing the upload
 *   4. rewrite the one database column that pointed at the old copy
 *
 * The source asset is NEVER deleted. A migration that cannot be re-run and
 * cannot be undone is not one worth running against production, and the source
 * cloud staying intact is what makes the rollback file below meaningful.
 *
 * ── PDFs need the delivery box ticked on BOTH clouds ──────────────────────
 *
 * 37 of the 97 assets are PDFs, and PDF delivery is currently DISABLED on the
 * source: every one answers 401 `deny or ACL failure`, while every jpg, png,
 * xlsx and docx answers 200. A disabled PDF is unreadable by the uploader
 * fetching it too, so the copy would fail — or worse, succeed in copying an
 * error page.
 *
 * So this refuses to start unless PDFs are actually readable on the source,
 * and checks the target the same way before writing anything. Settings →
 * Security → "Allow delivery of PDF and ZIP files", on each cloud.
 *
 * `--signed-source` is the alternative if you would rather not open PDF
 * delivery on the old cloud at all: it signs each source URL with the source
 * secret, which Cloudinary accepts for restricted types. Slower, and it needs
 * the source api_secret, but it leaves the old cloud's settings untouched.
 *
 * ── Credentials ───────────────────────────────────────────────────────────
 *
 * Both clouds, because this talks to both. Key and secret MUST belong to the
 * cloud named beside them — a mismatched pair is the single most likely way
 * for this to fail, and it fails as a signature error that reads like
 * something else.
 *
 *   CLOUDINARY_SOURCE_CLOUD_NAME   CLOUDINARY_SOURCE_API_KEY   CLOUDINARY_SOURCE_API_SECRET
 *   CLOUDINARY_TARGET_CLOUD_NAME   CLOUDINARY_TARGET_API_KEY   CLOUDINARY_TARGET_API_SECRET
 *
 * The source secret is only needed for --signed-source.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/migrate-cloudinary-assets.js                  # report only
 *   node scripts/migrate-cloudinary-assets.js --limit=3 --apply   # trial run
 *   node scripts/migrate-cloudinary-assets.js --apply             # all of it
 *   node scripts/migrate-cloudinary-assets.js --apply --signed-source
 *
 * Writes nothing without --apply. With it, every repointed row is recorded in
 * scripts/rollback-cloudinary-migration-<stamp>.json holding the previous URL,
 * so the database can be put back with the source assets still in place.
 *
 * Re-running is safe: a row already pointing at the target cloud is skipped.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const { Client } = require("pg");
const { v2: cloudinary } = require("cloudinary");

const APPLY = process.argv.includes("--apply");
const SIGNED_SOURCE = process.argv.includes("--signed-source");
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const LIMIT = arg("limit") ? Number(arg("limit")) : null;

const SRC = {
  cloud_name: process.env.CLOUDINARY_SOURCE_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_SOURCE_API_KEY,
  api_secret: process.env.CLOUDINARY_SOURCE_API_SECRET,
};
const DST = {
  cloud_name: process.env.CLOUDINARY_TARGET_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_TARGET_API_KEY,
  api_secret: process.env.CLOUDINARY_TARGET_API_SECRET,
};

/**
 * Every column that holds a delivery URL.
 *
 * Listed rather than discovered, so adding a new one is a deliberate edit and
 * a column that happens to contain a URL is never rewritten by surprise.
 */
const SOURCES = [
  { table: "pfi_expense_attachments", idCol: "id", urlCol: "storage_key", label: "expense attachment" },
  { table: "customer_licenses", idCol: "id", urlCol: "license_url", label: "customer licence" },
];

/**
 * Pull the public_id back out of a delivery URL.
 *
 * The two resource types spell it differently and getting this wrong is how a
 * migration silently creates a second copy under the wrong name: `raw` carries
 * the extension as part of the public_id, `image` does not.
 */
function parseUrl(url) {
  const m = String(url).match(
    /^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw|video)\/upload\/(?:v(\d+)\/)?(.+)$/
  );
  if (!m) return null;
  const [, cloud, resourceType, version, tail] = m;
  const publicId = resourceType === "raw" ? tail : tail.replace(/\.[^./]+$/, "");
  return { cloud, resourceType, version: version || null, tail, publicId };
}

/** GET the first byte. Enough to prove delivery without pulling the file. */
function probe(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: "GET", headers: { Range: "bytes=0-0" } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, cldError: res.headers["x-cld-error"] || "" });
    });
    req.on("error", (e) => resolve({ status: 0, cldError: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, cldError: "timeout" }); });
    req.end();
  });
}
const ok = (s) => s === 200 || s === 206;

/** A source URL the uploader can actually read, restricted types included. */
function sourceUrlFor(row) {
  if (!SIGNED_SOURCE) return row.url;
  return cloudinary.url(row.parsed.publicId, {
    ...SRC,
    resource_type: row.parsed.resourceType,
    type: "upload",
    version: row.parsed.version || undefined,
    sign_url: true,
    secure: true,
  });
}

function targetUrlOf(result) {
  return result.secure_url;
}

async function main() {
  for (const [label, cfg] of [["SOURCE", SRC], ["TARGET", DST]]) {
    if (!cfg.cloud_name || !cfg.api_key) {
      throw new Error(`${label} cloud is not configured — set CLOUDINARY_${label}_CLOUD_NAME and _API_KEY`);
    }
  }
  if (!DST.api_secret) throw new Error("TARGET api_secret is required to upload");
  if (SIGNED_SOURCE && !SRC.api_secret) throw new Error("--signed-source needs CLOUDINARY_SOURCE_API_SECRET");
  if (SRC.cloud_name === DST.cloud_name) throw new Error("source and target are the same cloud — nothing to do");

  console.log(`Migrating  ${SRC.cloud_name}  →  ${DST.cloud_name}`);
  console.log(`Mode: ${APPLY ? "APPLY (writes)" : "report only"}${SIGNED_SOURCE ? " · signed source URLs" : ""}\n`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // ── Gather ────────────────────────────────────────────────────────────
    let rows = [];
    for (const s of SOURCES) {
      const { rows: found } = await client.query(
        `SELECT ${s.idCol}::text AS id, ${s.urlCol} AS url FROM ${s.table}
          WHERE ${s.urlCol} LIKE '%res.cloudinary.com%' ORDER BY ${s.idCol}`
      );
      for (const r of found) rows.push({ ...r, ...s, parsed: parseUrl(r.url) });
    }

    const unparsable = rows.filter((r) => !r.parsed);
    rows = rows.filter((r) => r.parsed);

    const already = rows.filter((r) => r.parsed.cloud === DST.cloud_name);
    const wrongCloud = rows.filter((r) => r.parsed.cloud !== SRC.cloud_name && r.parsed.cloud !== DST.cloud_name);
    let todo = rows.filter((r) => r.parsed.cloud === SRC.cloud_name);
    if (LIMIT) todo = todo.slice(0, LIMIT);

    console.log(`  on source (${SRC.cloud_name}) : ${rows.filter((r) => r.parsed.cloud === SRC.cloud_name).length}`);
    console.log(`  already on target            : ${already.length}`);
    if (wrongCloud.length) console.log(`  on some OTHER cloud          : ${wrongCloud.length}  (left alone)`);
    if (unparsable.length) console.log(`  unrecognised URL shape       : ${unparsable.length}  (left alone)`);
    console.log(`  to migrate now               : ${todo.length}${LIMIT ? `  (--limit=${LIMIT})` : ""}\n`);

    if (todo.length === 0) {
      console.log("Nothing to migrate.");
      return;
    }

    // ── Pre-flight: can we actually read the source? ──────────────────────
    const pdfs = todo.filter((r) => /\.pdf$/i.test(r.parsed.tail));
    console.log(`Checking the source is readable (${todo.length} assets, ${pdfs.length} of them PDF)...`);
    const sample = [...todo.filter((r) => !/\.pdf$/i.test(r.parsed.tail)).slice(0, 2), ...pdfs.slice(0, 2)];
    const unreadable = [];
    for (const r of sample) {
      const res = await probe(sourceUrlFor(r));
      if (!ok(res.status)) unreadable.push({ url: r.url, ...res });
    }
    if (unreadable.length) {
      console.error("\nThe source will not serve these, so they cannot be copied:\n");
      for (const u of unreadable) console.error(`  ${u.status} ${u.cldError}  ${u.url}`);
      const pdfBlocked = unreadable.some((u) => /\.pdf$/i.test(u.url));
      throw new Error(
        pdfBlocked
          ? `PDF delivery looks disabled on ${SRC.cloud_name}. Tick Settings → Security → "Allow delivery of PDF and ZIP files" there, or re-run with --signed-source.`
          : `source assets are not deliverable from ${SRC.cloud_name}`
      );
    }
    console.log("  source readable ✓\n");

    if (!APPLY) {
      console.log("Report only — nothing written. Re-run with --apply.");
      console.log(`\nFirst few that would move:`);
      for (const r of todo.slice(0, 5)) {
        console.log(`  ${r.label} ${r.id}  ${r.parsed.resourceType}  ${r.parsed.publicId}`);
      }
      return;
    }

    // ── Migrate ───────────────────────────────────────────────────────────
    const done = [];
    const failed = [];

    for (const [i, r] of todo.entries()) {
      const tag = `[${i + 1}/${todo.length}] ${r.label} ${r.id}`;
      try {
        const uploaded = await cloudinary.uploader.upload(sourceUrlFor(r), {
          ...DST,
          resource_type: r.parsed.resourceType,
          public_id: r.parsed.publicId,
          type: "upload",
          // Keep the name it already had rather than minting a new one, and do
          // not let a re-run create a second copy beside the first.
          use_filename: false,
          unique_filename: false,
          overwrite: true,
          invalidate: true,
        });

        const newUrl = targetUrlOf(uploaded);
        const check = await probe(newUrl);
        if (!ok(check.status)) {
          // The copy exists but the target will not serve it — almost always
          // PDF delivery being disabled on the target too. Do NOT repoint the
          // database at something that cannot be read.
          failed.push({ ...r, stage: "verify", status: check.status, cldError: check.cldError, newUrl });
          console.log(`${tag}  uploaded but NOT deliverable (${check.status} ${check.cldError}) — row left alone`);
          continue;
        }

        await client.query(
          `UPDATE ${r.table} SET ${r.urlCol} = $1 WHERE ${r.idCol} = $2 AND ${r.urlCol} = $3`,
          [newUrl, r.id, r.url]
        );

        done.push({ table: r.table, idCol: r.idCol, id: r.id, urlCol: r.urlCol, from: r.url, to: newUrl });
        console.log(`${tag}  ✓ ${r.parsed.publicId}`);
      } catch (err) {
        failed.push({ ...r, stage: "upload", error: err.message });
        console.log(`${tag}  ✗ ${err.message}`);
      }
    }

    // ── Record ────────────────────────────────────────────────────────────
    if (done.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rollbackPath = path.join(__dirname, `rollback-cloudinary-migration-${stamp}.json`);
      fs.writeFileSync(
        rollbackPath,
        JSON.stringify(
          {
            wroteAt: new Date().toISOString(),
            from: SRC.cloud_name,
            to: DST.cloud_name,
            note: "Source assets were NOT deleted. Restore by setting each row's urlCol back to `from`.",
            rows: done,
          },
          null,
          2
        )
      );
      console.log(`\nRollback written to:\n  ${rollbackPath}`);
    }

    console.log(`\nMigrated ${done.length} of ${todo.length}.`);
    if (failed.length) {
      console.log(`${failed.length} failed — their rows still point at ${SRC.cloud_name} and nothing was lost:`);
      const byReason = {};
      for (const f of failed) {
        const k = f.stage === "verify" ? `not deliverable on target (${f.cldError || f.status})` : f.error;
        byReason[k] = (byReason[k] || 0) + 1;
      }
      for (const [reason, n] of Object.entries(byReason)) console.log(`  ${n} × ${reason}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

/* istanbul ignore else */
if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
  });
}

// Exported for tests/cloudinary-url-parse.test.js. Pulling the public_id back
// out of a URL is the one piece of pure logic here, and the one that silently
// creates a mis-named second copy when it is wrong.
module.exports = { parseUrl };
