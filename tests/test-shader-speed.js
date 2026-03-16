const fs = require('fs');
const path = require('path');
const gameRendererPath = path.join(__dirname, '..', 'gameRenderer.js');
let code = fs.readFileSync(gameRendererPath, 'utf8');

const minimalFrag = `
precision highp float;
varying vec2 vTexCoord;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, vTexCoord);
}
`;

code = code.replace(/const POST_FRAG = \`[\s\S]*?\`;/, `const POST_FRAG = \`${minimalFrag}\`;`);
fs.writeFileSync(gameRendererPath, code);
