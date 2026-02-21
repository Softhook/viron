const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    await page.goto('http://localhost:8000/index.html');
    await new Promise(r => setTimeout(r, 2000));
    await page.keyboard.press('1');
    await new Promise(r => setTimeout(r, 2000));
    await browser.close();
})();
