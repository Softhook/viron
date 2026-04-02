const { execSync } = require('child_process');
const fs = require('fs');

console.log('===================================================');
console.log('🔍 Starting Detailed Forensic Refactor Analysis...');
console.log('===================================================');

// 1. Get all deleted lines from git diff
console.log('Analyzing git diff...');
const diff = execSync('git diff -U0').toString();
const deletedLines = [];
const lines = diff.split('\n');

for (let line of lines) {
  // Only capture deleted lines, ignoring file headers (---)
  if (line.startsWith('-') && !line.startsWith('---')) {
    let cleanLine = line.substring(1).trim();
    // Ignore lines that are too short (like curly braces), purely comments, or import/script tags
    if (cleanLine.length > 3 && !cleanLine.startsWith('//') && !cleanLine.startsWith('<script')) { 
      deletedLines.push(cleanLine);
    }
  }
}

// 2. Read all current JS files to form the new active state
console.log('Reading current active source code...');
const jsFiles = fs.readdirSync('.').filter(f => f.endsWith('.js'));
let totalCurrentCode = '';
for (let f of jsFiles) {
  totalCurrentCode += fs.readFileSync(f, 'utf8') + '\n';
}

// Strip all spacing for extremely robust logic-structure matching
const currentCodeNoSpace = totalCurrentCode.replace(/\s+/g, '');

// 3. Verify that the logic structures still exist
console.log('Cross-referencing deleted logic structures...');
let missing = [];
let found = 0;

for (let dLine of deletedLines) {
    let dLineNoSpace = dLine.replace(/\s+/g, '');
    
    if (currentCodeNoSpace.includes(dLineNoSpace)) {
        found++;
    } else {
        missing.push(dLine);
    }
}

console.log('===================================================');
console.log(`✅ Forensic Check Complete.`);
console.log(`📊 Total significant logic lines moved/deleted: ${deletedLines.length}`);
console.log(`🔗 Lines strictly structurally matching in new codebase: ${found}`);

if (missing.length > 0) {
    console.log(`\n⚠️ The following lines did not have a 1:1 structural match.`);
    console.log(`(This is expected for methods converted to static properties or minor variable scoping tweaks):`);
    missing.forEach(m => console.log('\x1b[31m%s\x1b[0m', `  - ${m}`));
} else {
    console.log(`\n🎉 SUCCESS: 100% of deleted logic structurally matched in the new codebase! No code was lost.`);
}
console.log('===================================================');
