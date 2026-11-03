import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
if (process.platform === 'darwin') {
  const temporary=mkdtempSync(path.join(tmpdir(),'freelm-pairing-build-'));
  const destination=path.resolve('resources/pairing');mkdirSync(destination,{recursive:true});
  try {
    const outputs=['arm64','x86_64'].map(arch=>{
      const output=path.join(temporary,arch);
      execFileSync('xcrun',['swiftc','-O','-target',`${arch}-apple-macos14.0`,'native/pairing/PairingVault.swift','-o',output],{stdio:'inherit'});
      return output;
    });
    const universal=path.join(temporary,'freelm-pairing-vault');
    execFileSync('lipo',['-create',...outputs,'-output',universal],{stdio:'inherit'});
    // Ad-hoc staging only; release packaging must apply its approved signing identity.
    execFileSync('codesign',['--force','--sign','-','--identifier','app.freelm.desktop.pairing-vault',universal],{stdio:'inherit'});
    renameSync(universal,path.join(destination,'freelm-pairing-vault'));
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
