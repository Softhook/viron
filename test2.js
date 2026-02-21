const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
    
    // Serve a simple HTML file that uses p5
    const html = `<html>
    <head><script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js"></script></head>
    <body style="background: black; margin: 0;">
    <script>
    let myShader;
    const vert = \`
      precision highp float;
      attribute vec3 aPosition;
      uniform mat4 uProjectionMatrix;
      uniform mat4 uModelViewMatrix;
      void main() {
        gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
      }
    \`;
    const frag = \`
      precision mediump float;
      void main() {
        gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
      }
    \`;
    function setup() {
      createCanvas(400, 400, WEBGL);
      myShader = createShader(vert, frag);
    }
    function draw() {
      background(0);
      shader(myShader);
      fill(255, 0, 0); // Is this overriding the shader?
      box(100);
    }
    </script>
    </body></html>`;
    
    fs.writeFileSync('test.html', html);
    await page.goto('file://' + __dirname + '/test.html');
    await new Promise(r => setTimeout(r, 2000));
    const screenshot = await page.screenshot({encoding: 'base64'});
    // Check if middle pixel is pink or red
    // ... we don't need to do image processing, just console log a few pixels
    console.log("Screenshot length:", screenshot.length);
    await browser.close();
})();
