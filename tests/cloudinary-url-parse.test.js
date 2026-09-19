const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { parseUrl } = require("../scripts/migrate-cloudinary-assets");

/**
 * Reading a public_id back out of a Cloudinary delivery URL.
 *
 * Pure rules — no database, no network. This is the one piece of real logic in
 * the migration, and the one that fails quietly: a wrong public_id does not
 * error, it creates a correctly-uploaded copy under the wrong name, which is
 * only noticed later when something cannot find its file.
 *
 * The URLs below are real shapes taken from production rows.
 */

describe("raw assets keep their extension in the public_id", () => {
  test("a raw PDF", () => {
    const p = parseUrl(
      "https://res.cloudinary.com/djpyy3s9u/raw/upload/v1789676037/soroman/expenses/ci6wmyxppppyr2im3h3v.pdf"
    );
    assert.equal(p.cloud, "djpyy3s9u");
    assert.equal(p.resourceType, "raw");
    assert.equal(p.version, "1789676037");
    // The extension is PART of a raw public_id. Stripping it here is how you
    // end up with "…v2im3h3v" on the new cloud and a 404 from every link.
    assert.equal(p.publicId, "soroman/expenses/ci6wmyxppppyr2im3h3v.pdf");
  });

  test("a raw spreadsheet", () => {
    const p = parseUrl(
      "https://res.cloudinary.com/djpyy3s9u/raw/upload/v1788000000/soroman/expenses/gsdudbcifwyaty8bzw8c.xlsx"
    );
    assert.equal(p.publicId, "soroman/expenses/gsdudbcifwyaty8bzw8c.xlsx");
  });
});

describe("image assets drop their extension from the public_id", () => {
  test("an image PDF — same file type, different rule", () => {
    // 8 of the production PDFs are delivered as image/upload rather than raw.
    // They are the same kind of file and take the opposite rule, which is the
    // whole reason this function exists.
    const p = parseUrl(
      "https://res.cloudinary.com/djpyy3s9u/image/upload/v1789730280/soroman/expenses/abc123.pdf"
    );
    assert.equal(p.resourceType, "image");
    assert.equal(p.publicId, "soroman/expenses/abc123");
    assert.equal(p.tail, "soroman/expenses/abc123.pdf");
  });

  test("a jpg licence", () => {
    const p = parseUrl(
      "https://res.cloudinary.com/djpyy3s9u/image/upload/v1787509624/soroman/licenses/uul7yvkrsklvqibjpllv.jpg"
    );
    assert.equal(p.publicId, "soroman/licenses/uul7yvkrsklvqibjpllv");
  });

  test("only the final extension goes, not a dot inside the name", () => {
    const p = parseUrl(
      "https://res.cloudinary.com/djpyy3s9u/image/upload/v1/soroman/expenses/invoice.2026.09.png"
    );
    assert.equal(p.publicId, "soroman/expenses/invoice.2026.09");
  });

  test("a folder containing a dot is not mistaken for an extension", () => {
    const p = parseUrl("https://res.cloudinary.com/djpyy3s9u/image/upload/v1/a.b/c/file.jpg");
    assert.equal(p.publicId, "a.b/c/file");
  });
});

describe("shapes that must not be mangled", () => {
  test("a URL with no version still parses", () => {
    const p = parseUrl("https://res.cloudinary.com/djpyy3s9u/raw/upload/soroman/expenses/x.pdf");
    assert.equal(p.version, null);
    assert.equal(p.publicId, "soroman/expenses/x.pdf");
  });

  test("nested folders survive intact", () => {
    const p = parseUrl("https://res.cloudinary.com/djpyy3s9u/raw/upload/v1/a/b/c/d/e.pdf");
    assert.equal(p.publicId, "a/b/c/d/e.pdf");
  });

  test("the cloud name is read from the URL, not assumed", () => {
    // The migration decides what to skip from this, so reading it wrong would
    // mean re-migrating assets already moved.
    assert.equal(parseUrl("https://res.cloudinary.com/sw0qmqky/raw/upload/v1/x.pdf").cloud, "sw0qmqky");
  });

  test("anything that is not a delivery URL returns null rather than guessing", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "not a url",
      "https://example.com/some/file.pdf",
      // A fetch URL is not an upload URL and must never be rewritten as one.
      "https://res.cloudinary.com/djpyy3s9u/image/fetch/https://x.com/a.jpg",
    ]) {
      assert.equal(parseUrl(bad), null, `${String(bad)} must not parse`);
    }
  });
});
