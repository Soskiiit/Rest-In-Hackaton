// Renders previews/*.png through the viewer and fails on any console error or failed request.
// Uses installed Google Chrome; set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use another Chromium.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const PORT = 8767;
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { stdio: 'ignore' });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
  page.on('requestfailed', r => problems.push('failed: ' + r.url()));
  for (let i = 0; i < 20; i++) {
    try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  await page.waitForFunction(() => window.marketPreview?.ready, null, { timeout: 15000 });
  const stats = await page.evaluate(() => window.marketPreview.stats());
  for (const entry of manifest.models) {
    const s = stats.find(x => x.name + '.glb' === entry.file);
    assert.deepEqual(s.clips.map(c => c.name), entry.animations);
    assert.equal(s.slots, entry.slots);
  }
  console.log(JSON.stringify(stats.map(({ name, triangles, slots, size }) => ({ name, triangles, slots, size: size.map(v => +v.toFixed(2)) }))));
  // Roll at a quarter of the clip: cart wheels have turned 90° clockwise (moving towards +X).
  await page.evaluate(() => marketPreview.pose('Roll', .5));
  const roll = await page.evaluate(() => marketPreview.snapshot(['L_Wheel', 'R_Wheel']));
  let wheels = 0;
  for (const cart of Object.values(roll)) for (const w of Object.values(cart)) if (w) {
    assert(Math.abs(w.q[2] + Math.SQRT1_2) < 1e-3 && Math.abs(w.q[3] - Math.SQRT1_2) < 1e-3, JSON.stringify(w)); wheels++;
  }
  assert.equal(wheels, 4);
  // Open / Close end poses move their parts away from the rest pose.
  for (const [clipName, parts] of [['Open', ['FrontWindow', 'CandyLid']], ['Close', ['Shutter']]]) {
    await page.evaluate(() => marketPreview.pose('Idle', 0));
    const rest = await page.evaluate(p => marketPreview.snapshot(p), parts);
    await page.evaluate(c => marketPreview.pose(c, 1.5), clipName);
    const end = await page.evaluate(p => marketPreview.snapshot(p), parts);
    let moved = 0;
    for (const model of Object.keys(end)) for (const n of parts) if (end[model][n]) {
      assert.notDeepEqual(end[model][n], rest[model][n], model + '/' + n + ' did not move'); moved++;
    }
    assert.equal(moved, parts.length);
  }
  console.log('Roll: 4 wheels turn 90° in 0.5 s; Open: 2 parts move; Close: shutter moves');
  const shots = [
    ['market-angle', 'all', 'angle', 'Idle', 0, false],
    ['carts-angle', 'carts', 'angle', 'Idle', 1, false],
    ['carts-back-open', 'carts', 'back', 'Open', 1.5, false],
    ['stalls-angle', 'stalls', 'angle', 'Idle', 1, false],
    ['stalls-slots', 'stalls', 'front', 'Idle', 0, true],
    ['stalls-closed', 'stalls', 'angle', 'Close', 1.5, false],
  ];
  for (const [file, model, view, clip, time, slots] of shots) {
    await page.evaluate(([m, v, c, t, s]) => { marketPreview.showSlots(s); marketPreview.select(m); marketPreview.setView(v); marketPreview.pose(c, t); }, [model, view, clip, time, slots]);
    await page.locator('#viewport canvas').screenshot({ path: `previews/${file}.png` });
  }
  assert.deepEqual(problems, []);
  console.log('previews: ' + shots.length + ' images, no console errors or failed requests');
} finally {
  await browser.close();
  server.kill();
}
