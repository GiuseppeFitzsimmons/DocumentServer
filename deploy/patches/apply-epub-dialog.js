/**
 * Replaces the epub direct-redirect intercept with a native DS dialog
 * that shows export options before triggering the export.
 *
 * Run: node deploy/patches/apply-epub-dialog.js deploy/patches/documenteditor-app.js
 */

const fs = require('fs');
const target = process.argv[2] || 'deploy/patches/documenteditor-app.js';

let code = fs.readFileSync(target, 'utf8');

const oldCode = 'if(c)return window.location.href="/api/files/"+c+"/export/epub",void(t&&t.hide())';

const dialogHtml = [
  '<div style="padding:20px">',
  '<p style="margin:0 0 16px;font-size:13px">Configure your EPUB export:</p>',
  '<label style="display:block;margin:8px 0;font-size:13px;cursor:pointer">',
  '<input type="checkbox" checked style="margin-right:8px"/>Include Table of Contents</label>',
  '<label style="display:block;margin:8px 0;font-size:13px;cursor:pointer">',
  '<input type="checkbox" checked style="margin-right:8px"/>Embed fonts</label>',
  '<label style="display:block;margin:8px 0;font-size:13px;cursor:pointer">',
  '<input type="checkbox" style="margin-right:8px"/>Use chapter-based splitting</label>',
  '</div>',
].join('');

const escapedHtml = dialogHtml.replace(/"/g, '\\"');

const newCode = [
  'if(c){',
  't&&t.hide();',
  'var _epubDlg=new Common.UI.Window({',
  'title:"EPUB Export Options",',
  'width:420,height:280,',
  'cls:"modal-dlg",',
  'buttons:["ok","cancel"],',
  'primary:"ok",',
  'header:true',
  '});',
  '_epubDlg.on("close",function(d,r){',
  'if(r=="ok"){window.location.href="/api/files/"+c+"/export/epub"}',
  '});',
  'var _epubBody=_epubDlg.getChild(".body");',
  'if(_epubBody&&_epubBody.length){_epubBody.html("' + escapedHtml + '")}',
  '_epubDlg.show();',
  'return}',
].join('');

if (!code.includes(oldCode)) {
  console.error('ERROR: Epub redirect pattern not found in ' + target);
  process.exit(1);
}

code = code.replace(oldCode, newCode);
fs.writeFileSync(target, code);
console.log('Epub dialog patch applied to ' + target);
