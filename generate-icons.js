/**
 * generate-icons.js
 * Generates PNG icons for the Viron PWA from the SVG source files.
 * Uses Puppeteer (already a devDependency).
 *
 * Usage: node generate-icons.js
 */

'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const ICONS_DIR = path.join(__dirname, 'icons');

const SIZES = [
  { src: 'icon.svg',          out: 'icon-192.png',          size: 192 },
  { src: 'icon.svg',          out: 'icon-512.png',          size: 512 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-192.png', size: 192 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  // Apple touch icon – 180×180 recommended for modern iPhones
  { src: 'icon.svg',          out: 'apple-touch-icon.png',  size: 180 },
];

async function renderIcon(page, svgPath, outPath, size) {
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin:0; padding:0; }
  body { width:${size}px; height:${size}px; overflow:hidden; background:transparent; }
  svg  { width:${size}px; height:${size}px; display:block; }
</style>
</head>
<body>${svgContent}</body>
</html>`;

  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: outPath, omitBackground: true });
  console.log(`  ✓  ${path.basename(outPath)}  (${size}×${size})`);
}

(async () => {
  console.log('Generating Viron PWA icons…');
  // Use system Chromium if the bundled one is unavailable (CI / sandboxed environments).
  const executablePath = process.env.CHROME_PATH ||
    (() => {
      const candidates = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
      ];
      return candidates.find(p => {
        try { fs.accessSync(p, fs.constants.X_OK); return true; }
        // accessSync throws if the path doesn't exist or isn't executable; skip it.
        catch { return false; }
      });
    })();

  const browser = await puppeteer.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  for (const { src, out, size } of SIZES) {
    const svgPath = path.join(ICONS_DIR, src);
    const outPath = path.join(ICONS_DIR, out);
    await renderIcon(page, svgPath, outPath, size);
  }

  await browser.close();
  console.log('Done – icons written to icons/');
})();
