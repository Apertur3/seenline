// Two harder fixtures (SYNTHETIC): a degraded photo of a whiteboard and a low-resolution noisy scan.
// Usage: node scripts/make-hard.ts   (needs playwright's chromium)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "./fixture-browser.ts";

const OUT = join(import.meta.dirname, "../test/fixtures/documents");
const NOISE = `<svg width="0" height="0"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .35 0"/></filter></svg>`;
const overlay = `<div style="position:absolute;inset:0;filter:url(#n);pointer-events:none"><svg width="100%" height="100%"><rect width="100%" height="100%" filter="url(#n)"/></svg></div>`;

const BOARD = `<html><body style="margin:0;background:#6f6f6a">${NOISE}<div style="position:relative;width:900px;height:640px;overflow:hidden">
<div style="position:absolute;left:50px;top:40px;width:760px;height:520px;background:radial-gradient(circle at 78% 22%,#fff 0,#e9e9e2 18%,#c9c9c0 70%);transform:rotate(-5deg) perspective(700px) rotateY(9deg);box-shadow:14px 14px 40px #0009;
font:38px 'Marker Felt','Bradley Hand',cursive;color:#3a4f86;padding:34px;box-sizing:border-box;filter:blur(1.1px) contrast(.85)">
<div>Q1 plan</div><div style="color:#8f4a4a">1. Launch: 12 Dec</div><div>2. Cap 73k EUR</div><div style="color:#4a7a55">3. Owner: Mira Haddad</div><div>Blocker: legal review</div></div>${overlay}</div></body></html>`;

const SCAN = `<html><body style="margin:0;background:#fff">${NOISE}<div style="position:relative;width:420px;height:300px;overflow:hidden;background:#f3f1ea">
<div style="transform:rotate(2.2deg) translate(8px,6px);font:13px 'Times New Roman',serif;color:#2a2a2a;filter:blur(.6px) contrast(.8) grayscale(1);padding:16px">
<b style="font-size:17px">Invoice 2027-0113</b><br>Seller: Ketelaar Hydr\u0061ulics B.V.<br>
<table style="border-collapse:collapse;margin:8px 0;font-size:12px"><tr><td style="padding:2px 12px 2px 0">Hose clamp</td><td style="padding:2px 12px">200</td><td style="padding:2px 12px">1.15</td><td>230.00</td></tr>
<tr><td style="padding:2px 12px 2px 0">Pump seal</td><td style="padding:2px 12px">14</td><td style="padding:2px 12px">48.60</td><td>680.40</td></tr></table>
Total due: EUR 7,281.40 by 15 January 2027.</div>${overlay}</div></body></html>`;

const browser = await chromium.launch();
const p = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
await p.setViewportSize({ width: 900, height: 640 });
await p.setContent(BOARD);
writeFileSync(join(OUT, "whiteboard-hard.jpg"), await p.screenshot({ type: "jpeg", quality: 35 }));
await p.setViewportSize({ width: 420, height: 300 });
await p.setContent(SCAN);
const jpg = (await p.screenshot({ type: "jpeg", quality: 40 })).toString("base64");
await p.setContent(
	`<html><body style="margin:0"><img style="width:100%" src="data:image/jpeg;base64,${jpg}"></body></html>`,
);
writeFileSync(join(OUT, "scan-hard.pdf"), await p.pdf());
await browser.close();
