import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalEnrollment } from '../../electron/pairing/enrollment';
import { NativePairingSecureStore } from '../../electron/pairing/secure-store';
import { LocalPairingListener } from '../../electron/pairing/listener';
import { InstanceHost } from '../../electron/instance-host';
import { mobileFixture } from '../../scripts/mobile-fixture';

const enabled=process.env.FREELM_SWIFT_ENROLLMENT_QA==='1';
it.skipIf(!enabled)('actual Swift CSR, native protected issuer, explicit local approval, mTLS Bots roundtrip and app/host restart',async()=>{
  const simulator='A427CFD4-8CB4-4734-AD7E-C83BDB6E3D76';const bundle='devplaceholder.MTDMLY96.FreeLMBots';
  const binary=process.env.FREELM_PAIRING_TEST_HELPER!;
  if(!binary)throw Error('Explicit QA helper required');
  const directory=await mkdtemp(path.join(tmpdir(),'freelm-enrollment-'));const scope=randomUUID();
  const keychain=path.join(directory,'vault.keychain');
  execFileSync(binary,['--isolated-keychain',keychain],{input:JSON.stringify({operation:'initialize-test-keychain',password:randomBytes(32).toString('hex')})});
  const store=new NativePairingSecureStore(binary,keychain);const enrollment=new LocalEnrollment(store);await enrollment.initialize();
  const fixture=await mobileFixture();
  const host=new InstanceHost({instanceId:'synthetic-mac',name:'Synthetic Mac',port:0,token:randomBytes(32).toString('hex'),bots:fixture.bots,authority:fixture.authority});
  const makeListener=()=>new LocalPairingListener(new LocalEnrollment(store),{id:'synthetic-mac',name:'Synthetic Mac'},(req,res,check)=>host.handleAuthorizedMobile(req,res,check,()=>{}));
  let listener=makeListener();const reports:unknown[]=[];
  const launch=(phase:string)=>{
    try{execFileSync('xcrun',['simctl','terminate',simulator,bundle],{stdio:'ignore'});}catch{}
    execFileSync('xcrun',['simctl','launch',simulator,bundle,'--local-enrollment-qa'],{env:{...process.env,SIMCTL_CHILD_BOTS_ENROLLMENT_QA_DIRECTORY:directory,SIMCTL_CHILD_BOTS_ENROLLMENT_QA_SCOPE:scope,SIMCTL_CHILD_BOTS_ENROLLMENT_QA_PHASE:phase},stdio:'pipe'});
  };
  const report=async(phase:string)=>{let result:any;await expect.poll(async()=>{try{result=JSON.parse(await readFile(path.join(directory,`phone-${phase}.json`),'utf8'));return true;}catch{return false;}},{timeout:40000,interval:500}).toBe(true);reports.push(result);expect(result).toEqual({ok:true,phase});};
  try{
    await listener.start('https://127.0.0.1:0','127.0.0.1');
    await writeFile(path.join(directory,'invitation.json'),JSON.stringify(await listener.invite()),{mode:0o600});
    execFileSync('xcrun',['simctl','install',simulator,path.resolve('../FreeLMBots/.build-pairing-integration/Build/Products/Debug-iphonesimulator/FreeLMBots.app')],{stdio:'pipe'});
    launch('pair');let pending:Awaited<ReturnType<LocalEnrollment['localStatus']>>['pending'];
    await expect.poll(async()=>{pending=(await enrollment.localStatus()).pending;return !!pending;},{timeout:30000,interval:500}).toBe(true);
    await enrollment.approve(pending!.requestId,pending!.keyHash);await report('pair');
    const endpoint=listener.endpoint!;await listener.stop();listener=makeListener();await listener.start(endpoint,'127.0.0.1');
    launch('resume');await report('resume');
    expect((await fixture.bots.snapshot()).conversations[0].messages.filter(m=>m.id==='actual-swift-enrollment')).toHaveLength(1);
    await enrollment.revoke();launch('cleanup');await report('cleanup');
    await writeFile('docs/evidence/pairing-enrollment/swift-integration-report.json',JSON.stringify({phases:reports,nativeIssuerStorage:true,loopbackOnly:true,wanValidated:false},null,2));
  }finally{
    // Always attempt scoped cleanup, including a failed phone run. Never clear general app data.
    try{launch('cleanup');await report('cleanup');}catch{}
    try{execFileSync('xcrun',['simctl','terminate',simulator,bundle],{stdio:'ignore'});execFileSync('xcrun',['simctl','launch',simulator,bundle],{stdio:'pipe'});}catch{}
    await listener.stop();await fixture.close();await rm(directory,{recursive:true,force:true});
  }
},120000);
