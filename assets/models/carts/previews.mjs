// Renders previews/*.png through the viewer and fails on any console error or failed request.
// Uses installed Google Chrome; set PLAYWRIGHT_CHROMIUM_EXECUTABLE to use another Chromium.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const PORT = 8767;
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
  await page.waitForFunction(() => window.cartPreview?.ready, null, { timeout: 15000 });
  const stats = await page.evaluate(() => window.cartPreview.stats());
  for (const s of stats) assert.deepEqual(s.clips.map(c => c.name), ['Idle', 'Roll', 'Open']);
  console.log(JSON.stringify(stats, null, 1));
  // Roll at a quarter of the clip: big wheels have turned 90° clockwise (moving towards +X).
  await page.evaluate(() => cartPreview.pose('Roll', .5));
  const roll = await page.evaluate(() => cartPreview.snapshot(['L_Wheel', 'R_Wheel']));
  for (const cart of Object.values(roll)) for (const w of Object.values(cart)) {
    assert(Math.abs(w.q[2] + Math.SQRT1_2) < 1e-3 && Math.abs(w.q[3] - Math.SQRT1_2) < 1e-3, JSON.stringify(w));
  }
  // Open end pose: doors, sliding glass and pot lid moved away from the rest pose.
  const parts = ['CabinetDoor', 'SlidingGlass', 'BoxDoor', 'PotLid'];
  await page.evaluate(() => cartPreview.pose('Idle', 0));
  const rest = await page.evaluate(p => cartPreview.snapshot(p), parts);
  await page.evaluate(() => cartPreview.pose('Open', 1.5));
  const open = await page.evaluate(p => cartPreview.snapshot(p), parts);
  let moved = 0;
  for (const cart of Object.keys(open)) for (const n of parts) if (open[cart][n]) {
    assert.notDeepEqual(open[cart][n], rest[cart][n], cart + '/' + n + ' did not move'); moved++;
  }
  assert.equal(moved, 4);
  console.log('Roll: wheels turn 90° in 0.5 s; Open: ' + moved + ' parts move');
  const shots = [
    ['carts-angle', 'both', 'angle', 'Idle', 0],
    ['carts-front', 'both', 'front', 'Idle', 0],
    ['carts-back-open', 'both', 'back', 'Open', 1.5],
    ['cart_banh_mi-angle', 'cart_banh_mi', 'angle', 'Idle', 1],
    ['cart_thai_noodle-angle', 'cart_thai_noodle', 'angle', 'Idle', 1],
  ];
  for (const [file, model, view, clip, time] of shots) {
    await page.evaluate(([m, v, c, t]) => { cartPreview.selectModel(m); cartPreview.setView(v); cartPreview.pose(c, t); }, [model, view, clip, time]);
    await page.locator('#viewport canvas').screenshot({ path: `previews/${file}.png` });
  }
  assert.deepEqual(problems, []);
  console.log('previews: ' + shots.length + ' images, no console errors or failed requests');
} finally {
  await browser.close();
  server.kill();
}
