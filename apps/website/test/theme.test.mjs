import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const css = read("../src/styles.css");
const flow = read("../src/flow.js");
const favicon = read("../src/favicon.svg");
const html = read("../src/index.html");

test("accents are blue and white, base background unchanged", () => {
  assert.match(css, /--bg:#0a0b0a; --surface:#121412;/);
  assert.match(css, /--accent:#5b9bff; --accent-2:#e8f0ff; --accent-fill:#2563eb; --on-accent:#ffffff;/);
  assert.match(css, /--fg:#f1f2ee; --muted:#a2a69e; --dim:#686c65;/);
});

test("no green accent left in styles, light strands, favicon or logo", () => {
  for (const [name, src] of [["styles.css", css], ["flow.js", flow], ["favicon.svg", favicon], ["index.html", html]]) {
    for (const green of ["#c8f25a", "#62d6c4", "200,242,90", "98,214,196"]) {
      assert.ok(!src.includes(green), `${name} still has ${green}`);
    }
  }
  assert.match(flow, /\[91,155,255\]/);
  assert.match(flow, /\[232,240,255\]/);
});

test("filled accent surfaces use the darker blue so white text stays readable", () => {
  for (const sel of [".btn.primary{background:var(--accent-fill)", ".cta-card{background:var(--accent-fill)", ".skip{position:absolute;left:12px;top:-60px;z-index:80;background:var(--accent-fill)"]) {
    assert.ok(css.includes(sel), `missing ${sel}`);
  }
});
