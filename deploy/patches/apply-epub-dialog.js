/**
 * Replaces the epub direct-redirect intercept with a native DS dialog
 * that fetches headings and shows section selection.
 * Run: node deploy/patches/apply-epub-dialog.js deploy/patches/documenteditor-app.js
 */

const fs = require('fs');
const target = process.argv[2] || 'deploy/patches/documenteditor-app.js';

let code = fs.readFileSync(target, 'utf8');

const oldCode = 'if(c)return window.location.href="/api/files/"+c+"/export/epub",void(t&&t.hide())';

const newCode = [
  'if(c){t&&t.hide();',
  // Fetch headings then show dialog
  'fetch("/api/files/"+c+"/export/headings",{credentials:"include"}).then(function(r){return r.json()}).then(function(headings){',
  'var secHtml="";',
  'if(headings&&headings.length>0){',
  'secHtml="<div style=\\"max-height:150px;overflow-y:auto;border:1px solid #eee;border-radius:3px;padding:8px;margin-top:12px\\">";',
  'for(var i=0;i<headings.length;i++){',
  'var h=headings[i];',
  'var indent=(h.level-1)*16;',
  'secHtml+="<label style=\\"display:block;margin:4px 0;padding-left:"+indent+"px;font-size:12px;cursor:pointer\\"><input type=\\"checkbox\\" checked data-idx=\\""+ h.index +"\\" style=\\"margin-right:6px\\"/>"+h.text+"</label>";',
  '}',
  'secHtml+="</div>";',
  '}',
  'var msg="<div style=\\"text-align:left;padding:10px 0\\">"',
  '+"<label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" checked id=\\"epub-opt-toc\\" style=\\"margin-right:8px\\"/>Include generated Table of Contents</label>"',
  '+"<label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" checked id=\\"epub-opt-fonts\\" style=\\"margin-right:8px\\"/>Embed fonts</label>"',
  '+"<label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" id=\\"epub-opt-sections\\" style=\\"margin-right:8px\\"/>Convert section breaks to page breaks</label>"',
  '+"<label style=\\"display:block;margin:8px 0;font-size:13px;cursor:pointer\\"><input type=\\"checkbox\\" id=\\"epub-opt-softreturns\\" style=\\"margin-right:8px\\"/>Remove soft returns</label>"',
  '+(headings&&headings.length>0?"<p style=\\"margin:16px 0 6px;font-size:13px;font-weight:500\\">Sections to include:</p>"+secHtml:"")',
  '+"</div>";',
  'Common.UI.warning({',
  'width:500,',
  'title:"EPUB Export Options",',
  'msg:msg,',
  'buttons:["ok","cancel"],',
  'primary:"ok",',
  'callback:function(r){',
  'if(r=="ok"){',
  'var params=[];',
  'var tocEl=document.getElementById("epub-opt-toc");',
  'if(tocEl&&!tocEl.checked)params.push("toc=0");',
  'var fontsEl=document.getElementById("epub-opt-fonts");',
  'if(fontsEl&&!fontsEl.checked)params.push("fonts=0");',
  'var sectionsEl=document.getElementById("epub-opt-sections");',
  'if(sectionsEl&&sectionsEl.checked)params.push("sections=1");',
  'var softEl=document.getElementById("epub-opt-softreturns");',
  'if(softEl&&softEl.checked)params.push("softreturns=0");',
  'var excluded=[];',
  'var boxes=document.querySelectorAll("[data-idx]");',
  'for(var j=0;j<boxes.length;j++){if(!boxes[j].checked)excluded.push(boxes[j].getAttribute("data-idx"))}',
  'if(excluded.length>0)params.push("exclude="+excluded.join(","));',
  'var q=params.length?"?"+params.join("&"):"";',
  'window.location.href="/api/files/"+c+"/export/epub"+q',
  '}',
  '}',
  '});',
  '}).catch(function(){',
  // Fallback: export without options if heading fetch fails
  'window.location.href="/api/files/"+c+"/export/epub"',
  '});',
  'return}',
].join('');

if (!code.includes(oldCode)) {
  console.error('ERROR: Epub redirect pattern not found in ' + target);
  process.exit(1);
}

code = code.replace(oldCode, newCode);
fs.writeFileSync(target, code);
console.log('Epub dialog patch applied to ' + target);
