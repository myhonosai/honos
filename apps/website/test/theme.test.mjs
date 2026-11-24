import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const css = read("../src/styles.css");
const story = read("../src/story.css");
const favicon = read("../src/favicon.svg");
const html = read("../src/index.html");

test("HON night blue base with paper chapters and gold stars (David chose Demo B in blue, 2026-11-19)", () => {
  assert.match(css, /--bg:#060d1f; --surface:#0b1630; --paper:#f2f5fb; --ink:#0d1530;/);
  assert.match(css, /--accent:#7aa7ff; --accent-2:#b7d0ff; --accent-fill:#2f56c4; --on-accent:#ffffff;/);
  assert.match(css, /--gold:#f3cf7a;/);
});

test("no green accent left in styles, favicon or logo", () => {
  for (const [name, src] of [["styles.css", css], ["story.css", story], ["favicon.svg", favicon], ["index.html", html]]) {
    for (const green of ["#c8f25a", "#62d6c4", "200,242,90", "98,214,196", "#4f6b52", "#0f1a14"]) {
      assert.ok(!src.includes(green), `${name} still has ${green}`);
    }
  }
});

test("filled accent surfaces use the darker blue so white text stays readable", () => {
  for (const sel of [".btn.primary{background:var(--accent-fill);color:var(--on-accent)", ".skip{position:absolute;left:12px;top:-60px;z-index:120;background:var(--accent-fill)"]) {
    assert.ok(css.includes(sel), `missing ${sel}`);
  }
});
