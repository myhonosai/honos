import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const blog = readFileSync(new URL("../scripts/blog.mjs", import.meta.url), "utf8");

test("base background is deep navy blue, accents unchanged", () => {
  assert.match(css, /--bg:#0a1122;/);
  assert.match(css, /--surface:#121b30;/);
  assert.match(css, /--accent:#c8f25a; --accent-2:#62d6c4;/);
  assert.match(css, /--fg:#f1f2ee; --muted:#a2a69e; --dim:#686c65;/);
});

test("no leftover near-black green-tinted base tints", () => {
  for (const old of ["#0a0b0a", "#121412", "rgba(10,11,10,", "rgba(13,14,13,", "rgba(24,26,24,", "rgba(14,16,14,", "rgba(8,9,8,", "#0e0f0e", "#1b1d1b"]) {
    assert.ok(!css.includes(old), `styles.css still has ${old}`);
  }
});

test("browser theme-color matches the base", () => {
  assert.match(html, /name="theme-color" content="#0a1122"/);
  assert.match(blog, /name="theme-color" content="#0a1122"/);
});
