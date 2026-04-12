const fs = require('fs');
const lines = fs.readFileSync('sfx.js', 'utf8').split('\n');

// Lines 805 to 1316 in 1-based index means index 804 to 1315.
const tunesContent = `// =============================================================================
// sfxTunes.js — Level completion atmospheric tunes array
// =============================================================================

const SFX_LEVEL_TUNES = [\n` + lines.slice(810, 1316).join('\n') + `;\n`;
fs.writeFileSync('sfxTunes.js', tunesContent);

// Remove the _levelTunes array completely from GameSFX.
lines.splice(804, 1316 - 805 + 1);

// Replace playNewLevel logic
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Math.floor(Math.random() * this._levelTunes.length)')) {
    lines[i] = lines[i].replace('this._levelTunes.length', 'SFX_LEVEL_TUNES.length');
  }
  if (lines[i].includes('this._levelTunes[pick](ctx, t, targetNode)')) {
    lines[i] = lines[i].replace('this._levelTunes[pick](ctx, t, targetNode)', 'SFX_LEVEL_TUNES[pick].call(this, ctx, t, targetNode)');
  }
  if (lines[i].includes('inside each _levelTunes entry')) {
    lines[i] = lines[i].replace('_levelTunes', 'SFX_LEVEL_TUNES');
  }
}

fs.writeFileSync('sfx.js', lines.join('\n'));
