// Optional integration checks: Node 22+ and a local Chromium browser. No packages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'solmate-browser-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((req, res) => {
  // Serve under a repository subdirectory to verify GitHub Pages paths.
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (!pathname.startsWith('/ticap-game/')) { res.writeHead(404).end(); return; }
  const relative = pathname.slice('/ticap-game/'.length) || 'index.html';
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(filename, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(filename)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(data);
  });
});
let browser;
let socket;
let seq = 0;
const pending = new Map();
const errors = [];
const missing = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, timeout = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  const diagnostic = await evaluate(`({hidden:document.hidden,visibility:document.visibilityState,focus:document.hasFocus(),timeline:document.timeline.currentTime,spins:document.getElementById('spins')?.textContent,events:window.lifecycleLog,animations:document.getAnimations().filter(a=>a.effect.target.className==='reel-strip').map(a=>({state:a.playState,pending:a.pending,time:a.currentTime,start:a.startTime,duration:a.effect.getTiming().duration}))})`);
  throw new Error(`Timed out: ${expression}\n${JSON.stringify(diagnostic)}`);
}
async function click(id) { return evaluate(`document.getElementById(${JSON.stringify(id)}).click()`); }
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const directory = path.join(__dirname, 'artifacts');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(result.data, 'base64'));
}
async function fixedSpin(value) {
  await evaluate(`window.savedRandom = Math.random; Math.random = () => ${value}; document.getElementById('spin').click(); Math.random = window.savedRandom;`);
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
}

async function spinRows(rows) {
  const samples = { panel: .07, sun: .25, tree: .45, house: .62, battery: .78, wind: .93 };
  const randoms = Array.from({ length: 5 }, (_, column) => rows.map(row => samples[row[column]])).flat();
  await evaluate(`(() => {
    const original = Math.random, values = ${JSON.stringify(randoms)}; let i = 0;
    Math.random = () => i < values.length ? values[i++] : original();
    try { document.getElementById('spin').click(); } finally { Math.random = original; }
  })()`);
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  const displayed = await evaluate(`Array.from({length:3},(_,row)=>Array.from(document.querySelectorAll('.reel-strip'),strip=>strip.children[row].dataset.symbol))`);
  assert.deepEqual(displayed, rows, 'the displayed board is the committed random outcome');
}

async function assertAligned() {
  const geometry = await evaluate(`Array.from(document.querySelectorAll('.reel'), reel => {
    const rect = reel.getBoundingClientRect(), cells = reel.querySelectorAll('.symbol');
    return {count:cells.length, top:cells[0].getBoundingClientRect().top-rect.top,
      bottom:cells[2].getBoundingClientRect().bottom-rect.bottom,
      sizes:Array.from(cells,cell=>cell.getBoundingClientRect().height)};
  })`);
  geometry.forEach(reel => {
    assert.equal(reel.count, 3);
    assert.ok(Math.abs(reel.top) < .1 && Math.abs(reel.bottom) < .1, `complete, aligned cells: ${JSON.stringify(reel)}`);
    assert.ok(reel.sizes.every(size => Math.abs(size - reel.sizes[0]) < .1));
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const debuggerURL = await new Promise((resolve, reject) => {
    browser.stderr.on('data', data => {
      stderr += data.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    browser.on('error', reject);
    browser.on('exit', code => reject(new Error(`Browser exited ${code}: ${stderr}`)));
  });
  const port = new URL(debuggerURL).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) missing.push(message.params.response.url);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/ticap-game/` });
  await waitFor(`document.readyState === 'complete' && document.querySelectorAll('.symbol').length === 15`);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '5');
  assert.equal(await evaluate(`Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)`), true);
  await evaluate(`window.audioCreated=0; window.oscillatorsCreated=0; const NativeAudio=window.AudioContext; window.AudioContext=class extends NativeAudio { constructor(...args){ super(...args); window.testAudio=this; window.audioCreated++; } }; const createOsc=NativeAudio.prototype.createOscillator; NativeAudio.prototype.createOscillator=function(...args){ window.oscillatorsCreated++; return createOsc.apply(this,args); }`);
  await screenshot('desktop-ready');
  await assertAligned();

  // Real Web Animations must move strips; repeated activations cannot spend more spins.
  await evaluate(`document.getElementById('spin').click(); for(let i=0;i<20;i++) document.getElementById('spin').click()`);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '4');
  await sleep(300);
  assert.equal(await evaluate(`document.getAnimations().filter(a => a.effect.target.className === 'reel-strip').length`), 5);
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('.reel-strip')).transform`), 'matrix(1, 0, 0, 1, 0, 0)');
  await sleep(1700);
  assert.equal(await evaluate(`document.querySelectorAll('.reel-strip')[0].children.length`), 3, 'left reel stops first');
  assert.ok(await evaluate(`document.querySelectorAll('.reel-strip')[4].children.length`) > 3, 'right reel still moving');
  assert.equal(await evaluate(`document.getElementById('points').dataset.total`), '0', 'no scoring before the last reel stops');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.reel')).every(reel => reel.firstElementChild.getBoundingClientRect().bottom >= reel.getBoundingClientRect().bottom-.1)`), true, 'tail artwork covers settling bounce');
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(`window.audioCreated`), 1);
  assert.equal(await evaluate(`window.testAudio.state`), 'running');
  assert.ok(await evaluate(`window.oscillatorsCreated`) > 5, 'spin and reel-stop sounds generate audio');

  await click('new-player');
  await fixedSpin(0);
  assert.equal(await evaluate(`document.getElementById('points').dataset.total`), '3000', 'actual total commits before its visual count-up');
  await sleep(950);
  assert.equal(await evaluate(`document.getElementById('points').textContent`), '3,000');
  assert.equal(await evaluate(`document.querySelectorAll('.symbol.winner').length`), 15);
  assert.equal(await evaluate(`document.querySelectorAll('.payline').length`), 3);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.symbol')).every(cell => cell.dataset.symbol === 'panel')`), true);
  await screenshot('desktop-jackpot');
  await assertAligned();

  // Reset while the count-up and confetti are still running.
  await click('new-player'); await fixedSpin(0); await sleep(120); await click('new-player'); await sleep(1000);
  assert.equal(await evaluate(`document.getElementById('points').textContent`), '0');
  assert.equal(await evaluate(`document.getElementById('points').dataset.total`), '0');
  assert.equal(await evaluate(`document.querySelectorAll('.winner,.payline').length`), 0);

  // Reset in-flight, and ensure old promises cannot score or consume new session spins.
  await click('spin'); await sleep(200); await click('new-player'); await sleep(2900);
  assert.equal(await evaluate(`document.getElementById('points').textContent`), '0');
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '5');
  assert.equal(await evaluate(`document.querySelectorAll('.symbol').length`), 15);
  assert.equal(await evaluate(`document.getElementById('finish-dialog').open`), false);

  // Changing cell dimensions in the middle of a real spin must not move the landing.
  await click('spin'); await sleep(450);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  await assertAligned();
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click('new-player');

  // A held Enter on the focused native SPIN button must not activate another spin.
  await evaluate(`document.getElementById('spin').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true });
  await sleep(150);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '4', 'held key does not start another spin');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await click('new-player');

  // A frozen page simulates browser suspension; resume must complete the pending spin.
  await evaluate(`window.lifecycleLog=[]; for(const name of ['visibilitychange','freeze','resume']) document.addEventListener(name,()=>window.lifecycleLog.push({name,hidden:document.hidden,time:performance.now()}))`);
  await click('spin'); await sleep(300);
  await send('Page.setWebLifecycleState', { state: 'frozen' }); await sleep(3000);
  await send('Page.setWebLifecycleState', { state: 'active' });
  // CDP's "active" resumes execution but intentionally leaves the tab hidden.
  // Restore visibility as well, as happens when an exhibit visitor returns to the tab.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');
  await waitFor(`!document.hidden`);
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  await assertAligned(); await click('new-player');

  // Exercise pause/resume while some reels have already stopped, and reset while hidden.
  await click('spin'); await sleep(2050);
  await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(300);
  assert.equal(await evaluate(`document.getAnimations().filter(a=>a.effect.target.className==='reel-strip').every(a=>a.playState==='paused')`), true);
  await evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))`);
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  await assertAligned(); await click('new-player');

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // A controlled random stream creates a nonwinning board: row 1 starts panel/tree/…
  await evaluate(`window.savedRandom = Math.random; let n=0; Math.random=()=>[.01,.2,.4,.6,.75,.9][n++%6]; document.getElementById('spin').click(); Math.random=window.savedRandom;`);
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(`document.getElementById('points').textContent`), '0');
  assert.equal(await evaluate(`document.getElementById('feedback').classList.contains('is-win')`), false);
  await click('new-player');
  const noWin = [['sun','tree','house','battery','wind'], ['panel','sun','tree','house','battery'], ['tree','house','battery','wind','panel']];
  for (const [length, prize] of [[3,50], [4,150], [5,500]]) {
    const rows = noWin.map(row=>row.slice()); rows[1] = Array.from({length:5},(_,i)=>i<length?'sun':'tree');
    await click('new-player'); await spinRows(rows);
    assert.equal(await evaluate(`document.getElementById('points').dataset.total`), String(prize));
    assert.equal(await evaluate(`document.querySelectorAll('.winner').length`), length);
    assert.equal(await evaluate(`document.querySelectorAll('.payline').length`), 1);
    assert.equal(await evaluate(`document.querySelector('.payline').style.right`), `${(5-length)*20}%`);
  }
  await click('new-player');
  await spinRows([Array(5).fill('panel'), ['sun','sun','sun','tree','tree'], ['tree','tree','tree','tree','sun']]);
  assert.equal(await evaluate(`document.getElementById('points').dataset.total`), '1200');
  assert.equal(await evaluate(`document.querySelectorAll('.winner').length`), 12);
  assert.equal(await evaluate(`document.querySelectorAll('.payline').length`), 3);
  await spinRows(noWin);
  assert.equal(await evaluate(`document.querySelectorAll('.winner,.payline').length`), 0, 'old highlights clear on the next spin');
  assert.equal(await evaluate(`document.getElementById('points').dataset.total`), '1200', 'a loss does not change actual points');
  await click('new-player');
  for (let i = 0; i < 5; i++) await fixedSpin(.2);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '0');
  assert.equal(await evaluate(`document.getElementById('points').textContent`), '7,500');
  await evaluate(`for(let i=0;i<15;i++) document.getElementById('spin').click()`);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '0', 'exhaustion stays locked before the final dialog');
  assert.equal(await evaluate(`document.getElementById('spin').disabled`), true);
  await waitFor(`document.getElementById('finish-dialog').open`);
  assert.equal(await evaluate(`document.getElementById('final-points').textContent`), '7,500');
  await click('spin');
  assert.equal(await evaluate(`document.getElementById('points').textContent`), '7,500');
  await screenshot('final-score');
  await evaluate(`document.querySelector('#finish-dialog [data-close]').click(); document.getElementById('spin').click()`);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '0', 'closing the final dialog does not silently reset');
  await evaluate(`document.getElementById('finish-dialog').showModal()`);
  await click('next-player');
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '5');
  assert.equal(await evaluate(`document.getElementById('finish-dialog').open`), false);
  // Reset after the last award, before its delayed final dialog can appear.
  for (let i = 0; i < 5; i++) await fixedSpin(.2);
  await click('new-player'); await sleep(1800);
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '5');
  assert.equal(await evaluate(`document.getElementById('points').dataset.total`), '0');
  assert.equal(await evaluate(`document.getElementById('finish-dialog').open`), false, 'old final timer cannot reopen in a new session');

  await click('how-to-play');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '5');
  await evaluate(`document.querySelector('#rules-dialog [data-close]').click()`);
  await click('sound');
  assert.equal(await evaluate(`document.getElementById('sound').getAttribute('aria-pressed')`), 'false');
  const mutedOscillators = await evaluate(`window.oscillatorsCreated`);
  await fixedSpin(.2);
  assert.equal(await evaluate(`window.oscillatorsCreated`), mutedOscillators, 'muted spin creates no sounds');
  await click('new-player');
  await click('sound');
  assert.equal(await evaluate(`document.getElementById('sound').getAttribute('aria-pressed')`), 'true');
  // Keyboard shortcuts only apply when focus isn't on a native control.
  await evaluate(`document.activeElement.blur()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '4');
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  await click('new-player');
  await click('fullscreen');
  await waitFor(`!!document.fullscreenElement`);
  await click('fullscreen');
  await waitFor(`!document.fullscreenElement`);
  await evaluate(`window.savedFullscreen=document.documentElement.requestFullscreen; document.documentElement.requestFullscreen=undefined`);
  await click('fullscreen');
  assert.match(await evaluate(`document.getElementById('message').textContent`), /isn’t available/);
  await evaluate(`document.documentElement.requestFullscreen=window.savedFullscreen`);
  await click('new-player');

  for (const [width, height] of [[1440,900], [1024,768], [768,1024], [390,844], [320,700]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await sleep(150);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `no horizontal overflow at ${width}`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.reel')).every(reel => reel.getBoundingClientRect().width > 30)`), true);
    await assertAligned();
    await screenshot(`layout-${width}`);
  }
  // Real touch input, including multiple taps while a spin is running.
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evaluate(`document.getElementById('spin').scrollIntoView({block:'center'})`);
  const tap = await evaluate(`(()=>{const r=document.getElementById('spin').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for(let i=0;i<3;i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...tap, radiusX: 3, radiusY: 3, force: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  assert.equal(await evaluate(`document.getElementById('spins').textContent`), '4');
  await waitFor(`document.getElementById('reel-window').getAttribute('aria-busy') === 'false'`);
  await click('new-player');
  await click('how-to-play'); await screenshot('mobile-rules');
  assert.deepEqual(errors, [], 'no browser exceptions');
  assert.deepEqual(missing, [], 'all relative assets load under a subdirectory');
  console.log('Browser checks passed: sequential reel motion, exact alignment and outcome, 3/4/5 matches, multiple lines and jackpot, atomic totals, click/touch/held-key guards, exhaustion before/after the final dialog, resets during spin/count-up, resize during spin, page suspension and visibility recovery, reduced motion, sound/mute, instructions, fullscreen, local assets, and five responsive layouts.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch {} socket.close(); }
  browser?.kill(); server.close();
  // Only remove this unique temporary browser profile after verifying its parent.
  if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('solmate-browser-')) {
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
});
