const fs = require('fs');
const path = require('path');

const files = [
  'terrain.js', 'sfx.js', 'player.js', 'enemies.js', 'sketch.js', 
  'mobileControls.js', 'gameRenderer.js', 'constants.js', 'particles.js', 
  'shipDesigns.js', 'gameLoop.js'
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  const functions = [];
  let currentFunc = null;
  let braceCount = 0;
  let startLine = 0;
  
  lines.forEach((line, idx) => {
    // Match function declarations
    const funcMatch = line.match(/^(function|const\s+\w+\s*=|class\s+\w+|\w+\.prototype\.\w+\s*=|\w+\s*\..*=.*function|  \w+\([^)]*\).*{)/);
    const name = line.match(/function\s+(\w+)|const\s+(\w+)|class\s+(\w+)/);
    
    // Start tracking braces when we see a function-like construct
    if (funcMatch && line.includes('{')) {
      startLine = idx + 1;
      braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      currentFunc = { name: name ? (name[1] || name[2] || name[3] || 'unknown') : 'unknown', startLine, line };
    } else if (currentFunc) {
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      
      if (braceCount <= 0) {
        const size = idx - startLine + 1;
        if (size > 5) { // Only track functions > 5 lines
          functions.push({ name: currentFunc.name, start: startLine, end: idx + 1, size });
        }
        currentFunc = null;
      }
    }
  });
  
  functions.sort((a, b) => b.size - a.size);
  console.log(`\n${file} - Top 5 functions:`);
  functions.slice(0, 5).forEach(f => {
    console.log(`  ${f.name}: lines ${f.start}-${f.end} (${f.size} lines)`);
  });
});
