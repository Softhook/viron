const puppeteer = require('puppeteer');
const express = require('express');
const path = require('path');

async function main() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..')));
  const server = app.listen(0, async () => {
    const port = server.address().port;
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`));
    
    await page.goto(`http://localhost:${port}/index.html`);
    await new Promise(r => setTimeout(r, 2000));
    await browser.close();
    server.close();
    process.exit(0);
  });
}
main();
