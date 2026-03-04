const puppeteer = require('puppeteer');
const express = require('express');
const app = express();
app.use(express.static(__dirname));
const server = app.listen(3001, async () => {
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR:', err));
    await page.goto('http://localhost:3001/index.html', { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 10000));
    await browser.close();
    server.close();
    process.exit(0);
});
