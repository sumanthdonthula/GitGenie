'use strict';

// Render the extension's own SVG character into the PNG required by VSIX icons.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');

async function main() {
  const media = path.resolve(__dirname, '..', 'media');
  const html = await fs.readFile(path.join(media, 'view.html'), 'utf8');
  const svg = html.match(/<svg id="character"[\s\S]*?<\/svg>/)[0];
  const browser = await chromium.launch({ executablePath: process.env.GENIE_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>body{margin:0;background:radial-gradient(ellipse at 50% 40%,#44315f,#1d1728 80%)}svg{width:256px;height:256px}.smoke-puffs{opacity:0}</style>${svg}`);
    await page.screenshot({ path: path.join(media, 'icon.png') });
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
