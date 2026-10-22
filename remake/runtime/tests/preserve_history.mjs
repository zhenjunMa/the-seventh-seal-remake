// Existing test after-hooks write their historical report names. A new route
// suite keeps those files intact and records a separate aggregate report.
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.writeFile;
fs.writeFile=async function(path,...args){
  if(String(path).replaceAll('\\','/').includes('/runtime/evidence/'))return;
  return original.call(this,path,...args);
};
syncBuiltinESMExports();
