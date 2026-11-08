'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { demoSnapshot } = require('../src/git');

async function main() {
  const media = path.join(__dirname, '..', 'media');
  const server = http.createServer(async (req, res) => {
    try {
      const name = ({ '/': 'view.html', '/view.css': 'view.css', '/view.js': 'view.js' })[req.url];
      if (!name) { res.writeHead(404).end(); return; }
      let content = await fs.readFile(path.join(media, name), 'utf8');
      if (name === 'view.html') content = content.replaceAll('{{csp}}', "'self'").replaceAll('{{nonce}}', 'testNonce').replaceAll('{{css}}', '/view.css').replaceAll('{{js}}', '/view.js');
      res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(content);
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executablePath = process.env.GENIE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 340, height: 1040 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__messages = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.__messages.push(message) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__messages.some(m => m.type === 'ready'));
    const state = { type: 'state', mode: 'demo', snapshot: demoSnapshot(), animations: true, animate: true };
    await page.evaluate(state => window.postMessage(state, '*'), state);
    await page.getByText('DEMO · SAMPLE DATA').waitFor();
    assert.match(await page.locator('#overlaps').innerText(), /dev-2 made changes/);
    assert.match(await page.locator('#commit-subject').innerText(), /free shipping/);
    assert.ok(await page.locator('body').evaluate(el => el.classList.contains('summoning')));
    await page.waitForTimeout(2900);
    await page.screenshot({ path: path.join(__dirname, '..', '..', 'artifacts', 'extension-sidebar.png'), fullPage: true });
    await page.locator('#lamp').click();
    assert.ok(await page.locator('body').evaluate(el => el.classList.contains('summoning')));
    await page.waitForTimeout(650);
    assert.ok(await page.locator('.puff-one').evaluate(el => Number(getComputedStyle(el).opacity) > 0), 'Smoke must be visible during the reveal');
    await page.screenshot({ path: path.join(__dirname, '..', '..', 'artifacts', 'extension-smoke.png'), fullPage: true });
    await page.locator('#snooze').click();
    assert.ok(await page.evaluate(() => window.__messages.some(m => m.type === 'snooze')));
    await page.locator('#refresh').click();
    assert.ok(await page.evaluate(() => window.__messages.some(m => m.type === 'refresh')));
    assert.equal(await page.locator('#sync').isDisabled(), true, 'Sample data must not allow a real rebase');
    const live = { ...state, mode: 'watching', animate: false, sync: { canSync: true, target: 'origin/main', busy: false, paused: false }, fetchInfo: { enabled: true } };
    await page.evaluate(state => window.postMessage(state, '*'), live);
    await page.locator('#sync').click();
    assert.ok(await page.evaluate(() => window.__messages.some(m => m.type === 'sync')));
    assert.match(await page.locator('#watch-status').innerText(), /fetch every 30s/);
    assert.match(await page.locator('#sync-target').innerText(), /origin\/main/);
    await page.evaluate(state => window.postMessage(state, '*'), { ...live, sync: { ...live.sync, busy: true } });
    await page.waitForFunction(() => document.getElementById('sync').disabled);
    assert.equal(await page.locator('#sync').isDisabled(), true);
    await page.evaluate(state => window.postMessage(state, '*'), { ...live, sync: { ...live.sync, paused: true, message: 'Resolve and stage the conflicts.' } });
    await page.locator('#continueRebase').click();
    await page.locator('#abortRebase').click();
    assert.ok(await page.evaluate(() => window.__messages.some(m => m.type === 'continueRebase') && window.__messages.some(m => m.type === 'abortRebase')));
    await page.screenshot({ path: path.join(__dirname, '..', '..', 'artifacts', 'extension-rebase-recovery.png'), fullPage: true });
    await page.evaluate(state => window.postMessage(state, '*'), live);
    await page.screenshot({ path: path.join(__dirname, '..', '..', 'artifacts', 'extension-sync.png'), fullPage: true });
    const hostile = structuredClone(state);
    hostile.snapshot.overlaps[0].path = '<img src=x onerror=alert(1)>';
    hostile.animations = false;
    await page.evaluate(state => window.postMessage(state, '*'), hostile);
    await page.getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
    assert.equal(await page.locator('#overlaps img').count(), 0);
    assert.equal(await page.locator('.genie').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.evaluate(state => window.postMessage(state, '*'), state);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.genie-upper').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.setViewportSize({ width: 220, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Narrow sidebar must not scroll horizontally');
    await page.screenshot({ path: path.join(__dirname, '..', '..', 'artifacts', 'extension-narrow.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('Webview passed: animation, smoke, sync target/action, busy/demo guards, rebase recovery controls, untrusted text, reduced motion, 220px layout.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
