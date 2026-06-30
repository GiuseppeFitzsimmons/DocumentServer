/**
 * Replaces the epub direct-redirect intercept with a native DS dialog.
 * Run: node deploy/patches/apply-epub-dialog.js deploy/patches/documenteditor-app.js
 */

const fs = require('fs');
const target = process.argv[2] || 'deploy/patches/documenteditor-app.js';

let code = fs.readFileSync(target, 'utf8');

const oldCode = 'if(c)return window.location.href="/api/files/"+c+"/export/epub",void(t&&t.hide())';

// Use a simple confirm() dialog as PoC — native, no API dependency issues
const newCode = 'if(c){t&&t.hide();if(confirm("Export to EPUB?\\n\\nOptions (coming soon):\\n☑ Include Table of Contents\\n☑ Embed fonts\\n☐ Chapter-based splitting")){window.location.href="/api/files/"+c+"/export/epub"}return}';

if (!code.includes(oldCode)) {
  console.error('ERROR: Epub redirect pattern not found in ' + target);
  process.exit(1);
}

code = code.replace(oldCode, newCode);
fs.writeFileSync(target, code);
console.log('Epub dialog patch applied to ' + target);
