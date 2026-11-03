import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { extractFile, listPackage, getRawHeader } from '@electron/asar';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const app=path.resolve(process.argv[2] || 'release/combined-local-qa/mac-universal/FreeLM.app');
const wire=await getCurrentFuseWire(app);
for(const [name,expected] of [['RunAsNode',48],['EnableNodeOptionsEnvironmentVariable',48],['EnableNodeCliInspectArguments',48],['EnableEmbeddedAsarIntegrityValidation',49],['OnlyLoadAppFromAsar',49]]) {
  if(wire[FuseV1Options[name]]!==expected)throw Error(`Incorrect packaged fuse: ${name}`);
}
execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});
const archive=path.join(app,'Contents/Resources/app.asar');
const plist=JSON.parse(execFileSync('plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')],{encoding:'utf8'}));
const header=getRawHeader(archive);
const headerHash=createHash('sha256').update(header.headerString).digest('hex');
if(plist.ElectronAsarIntegrity?.['Resources/app.asar']?.hash!==headerHash)throw Error('ASAR header integrity mismatch');
const main=extractFile(archive,'dist-electron/main.cjs').toString();
if(!main.includes('localPairingReleaseVerified = false'))throw Error('Release gate must remain false in this QA build');
const assets=listPackage(archive).filter(name=>name.startsWith('/dist/assets/')&&name.endsWith('.js'));
if(!assets.some(name=>extractFile(archive,name.slice(1)).toString().includes('synchronize seamlessly')))throw Error('Restored onboarding copy missing');
const helper=path.join(app,'Contents/Resources/pairing/freelm-pairing-vault');
execFileSync('codesign',['--verify','--strict',helper],{stdio:'pipe'});
const test=spawnSync(helper,['--isolated-keychain','/tmp/invalid/vault.keychain'],{input:'{"operation":"read"}',encoding:'utf8'});
if(test.status!==2 || !test.stdout.includes('production helper does not accept arguments'))throw Error('QA flag boundary failed');
console.log(JSON.stringify({app,fusesVerified:true,strictSignatureVerified:true,asarHeaderHash:headerHash,onboardingCopyVerified:true,productionTestFlagsRejected:true,releaseGate:false,liveEnrollment:false},null,2));
