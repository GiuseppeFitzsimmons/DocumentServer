const fs = require('fs');
let code = fs.readFileSync('deploy/patches/documenteditor-app.js', 'utf8');

const oldCode = ')}):(this.isFromFileDownloadAs=ext,this.api.asc_DownloadAs(options),menu.hide())';

const newCode = ')}):((function(that){if(format==Asc.c_oAscFileType.EPUB){var r=that.getApplication().getController("Main").document.key;if(r){var l=r.split("_");l.pop();var c=l.join("_");if(c){window.location.href="/api/files/"+c+"/export/epub";if(menu)menu.hide();return}}}that.isFromFileDownloadAs=ext;that.api.asc_DownloadAs(options);menu.hide()})(this))';

if (!code.includes(oldCode)) {
  console.error('ERROR: Pattern not found in app.js');
  process.exit(1);
}

code = code.replace(oldCode, newCode);
fs.writeFileSync('deploy/patches/documenteditor-app.js', code);
console.log('Epub export patch applied successfully');
