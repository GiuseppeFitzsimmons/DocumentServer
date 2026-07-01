const fs = require('fs');
let code = fs.readFileSync('deploy/patches/documenteditor-app.js', 'utf8');

const target = 'else{if(e==Asc.c_oAscFileType.EPUB)';
const replacement = 'else{console.log("[EPUB DEBUG] clickSaveAsFormat e=",e,"EPUB=",Asc.c_oAscFileType.EPUB);if(e==Asc.c_oAscFileType.EPUB)';

if (!code.includes(target)) {
  console.error('Pattern not found');
  process.exit(1);
}

code = code.replace(target, replacement);
fs.writeFileSync('deploy/patches/documenteditor-app.js', code);
console.log('Debug logging added');
