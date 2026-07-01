/**
 * Replaces the epub direct-redirect intercept with a native DS dialog.
 * Run: node deploy/patches/apply-epub-dialog.js deploy/patches/documenteditor-app.js
 */

const fs = require('fs');
const target = process.argv[2] || 'deploy/patches/documenteditor-app.js';

let code = fs.readFileSync(target, 'utf8');

const oldCode = 'if(c)return window.location.href="/api/files/"+c+"/export/epub",void(t&&t.hide())';

const newCode = [
  'if(c){t&&t.hide();',
  'Common.UI.warning({',
  'width:500,',
  'title:"EPUB Export Options",',
  'msg:"<div style=\\"text-align:left;padding:10px 0\\"><label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" checked id=\\"epub-opt-toc\\" style=\\"margin-right:8px\\"/>Include Table of Contents</label><label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" checked id=\\"epub-opt-fonts\\" style=\\"margin-right:8px\\"/>Embed fonts</label><label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" id=\\"epub-opt-chapters\\" style=\\"margin-right:8px\\"/>Chapter-based splitting</label></div>",',
  'buttons:["ok","cancel"],',
  'primary:"ok",',
  'callback:function(r){',
  'if(r=="ok"){window.location.href="/api/files/"+c+"/export/epub"}',
  '}',
  '});return}',
].join('');

if (!code.includes(oldCode)) {
  console.error('ERROR: Epub redirect pattern not found in ' + target);
  process.exit(1);
}

code = code.replace(oldCode, newCode);
fs.writeFileSync(target, code);
console.log('Epub dialog patch applied to ' + target);
