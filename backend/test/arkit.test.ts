import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArkitPose, parseArkitPose } from '../src/modules/arkit/arkit.dto.js';
import { buildTrajectory, estimateAlignment, pairAnchors, localSegments, lineGeometry, type PosePoint, type GpsPoint, type FusionPoint, type Anchor } from '../src/modules/arkit/arkit.engine.js';
import { tmInverse } from '../src/geo/tm.js';
const epoch=Date.parse('2026-10-01T00:00:00Z');
const message={type:'arkit.pose',schemaVersion:1,sessionId:'00000000-0000-0000-0000-000000000001',arSessionId:'00000000-0000-0000-0000-000000000002',deviceId:'phone',sequence:0,timestamp:epoch,frameTimestamp:42,position:{x:1,y:2,z:3},rotation:{x:0,y:0,z:0,w:1},trackingState:'normal'};
test('pose contract accepts epoch milliseconds; preserves original frame clock',()=>{const p=parseArkitPose(message);assert.equal(p.timestamp,epoch);assert.equal(p.frameTimestamp,42);});
test('rejects fields, types, versions, clocks, states, unsafe sequences and non-unit quaternion',()=>{
  for(const key of Object.keys(message)) {const p:any={...message};delete p[key];assert.equal(ArkitPose.safeParse(p).success,false,key);}
  for(const patch of [{type:'telemetry:batch'},{schemaVersion:2},{timestamp:'2026-10-01T00:00:00Z'},{timestamp:Date.now()+3*86400000},{timestamp:0},{frameTimestamp:-1},{sequence:2**53},{trackingState:'unknown'},{rotation:{x:0,y:0,z:0,w:0}},{rotation:{x:0,y:0,z:0,w:3}}]) assert.throws(()=>parseArkitPose({...message,...patch}));
});
test('NaN / Infinity defense covers every vector and quaternion axis',()=>{
  for(const key of ['position','rotation'] as const) for(const axis of Object.keys(message[key])) for(const value of [NaN,Infinity,-Infinity]) {
    assert.throws(()=>parseArkitPose({...message,[key]:{...message[key],[axis]:value}}));
  }
  assert.throws(()=>parseArkitPose({...message,extra:'x'.repeat(5000)}));
});
const poses:PosePoint[]=Array.from({length:101},(_,i)=>({sequence:i,timestamp:epoch+i*100,frameTimestamp:42+i/10,x:i/5,y:1.4+i/100,z:-i/10,trackingState:'normal'}));
const angle=0.7,c=Math.cos(angle),s=Math.sin(angle);
const gps:GpsPoint[]=poses.filter((_,i)=>i%10===0).map(p=>({...tmInverse(201100+c*p.x+s*p.z,557250+s*p.x-c*p.z),timestamp:p.timestamp,horizontalAccuracy:2,altitude:100+p.y,ellipsoidalAltitude:null,verticalAccuracy:2}));
const fusion:FusionPoint[]=poses.filter((_,i)=>i%10===0).map(p=>({...tmInverse(201110+p.x,557240-p.z),timestamp:p.timestamp,ellipsoidalAltitude:125,segment:0}));
test('weighted rigid fit preserves scale, estimates rotation/translation and orthometric offset',()=>{
  const r=buildTrajectory(poses,gps,fusion);assert.equal(r.alignment.status,'aligned');assert.ok(r.alignment.rms!<0.01);
  assert.ok(Math.abs(r.alignment.transform!.angle-angle)<1e-5);assert.ok(Math.abs(r.alignment.transform!.verticalOffset!-100)<0.01);
  assert.equal(r.aligned[0].length,101);assert.ok(r.corrected.length);assert.ok(lineGeometry(r.aligned));
});
test('time pairing uses epoch, rejects inaccurate/unmatched GPS and limited poses',()=>{
  assert.equal(pairAnchors(poses,gps.map(g=>({...g,timestamp:g.timestamp+10000}))).length,1);
  assert.equal(pairAnchors(poses,gps.map(g=>({...g,horizontalAccuracy:50}))).length,0);
  assert.equal(pairAnchors(poses.map(p=>({...p,trackingState:'limited'})),gps).length,0);
});
test('one point / stationary track remains local; insufficient references never get geometry',()=>{
  const r=buildTrajectory(poses,gps.slice(0,1),fusion);assert.equal(r.alignment.status,'pending');assert.deepEqual(r.aligned,[]);assert.deepEqual(r.corrected,[]);assert.equal(lineGeometry(r.aligned),null);
  const a=pairAnchors(poses,gps).map(a=>({...a,u:0,v:0}));assert.equal(estimateAlignment(a).status,'pending');
});
test('robust fit rejects GPS outlier and cannot silently estimate scale',()=>{
  const a=pairAnchors(poses,gps);a[5]={...a[5],e:a[5].e+100,n:a[5].n-100};const r=estimateAlignment(a);assert.equal(r.status,'aligned');assert.equal(r.inliers,10);assert.ok(r.rms!<0.01);
  const scaled:Anchor[]=pairAnchors(poses,gps).map(a=>({...a,e:201100+4*a.u,n:557250+4*a.v}));assert.equal(estimateAlignment(scaled).status,'rejected');
});
test('missing height datum stays null; local path retains Y camera height',()=>{const r=buildTrajectory(poses,gps.map(g=>({...g,verticalAccuracy:null})),fusion);assert.equal(r.alignment.transform?.verticalOffset,null);assert.ok(r.aligned.flat().every(p=>p.h===null));assert.equal(localSegments(poses)[0][0].y,1.4);});
test('tracking losses and gaps split paths, fallback to fusion, resume without crossing loss',()=>{
  const lost=poses.map((p,i)=>({...p,trackingState:i>=40&&i<=50?'limited' as const:p.trackingState}));
  const r=buildTrajectory(lost,gps,fusion);assert.equal(r.aligned.length,3);
  assert.ok(r.corrected.flat().some(p=>p.source==='existing-fusion'));
  const gap=poses.filter((_,i)=>i<40||i>60);assert.equal(localSegments(gap).length,2);
  const unavailable=poses.map((p,i)=>({...p,trackingState:i>=40&&i<=50?'notAvailable' as const:p.trackingState}));
  assert.ok(buildTrajectory(unavailable,gps,fusion).aligned.flat().every(p=>p.source!=='notAvailable'));
});
test('relative VIO displacement bridges poor GPS; reanchors without averaging; no raw mutation',()=>{
  const weak=gps.map((g,i)=>({...g,horizontalAccuracy:i===5?50:2}));const before=JSON.stringify({poses,gps:weak,fusion});
  const r=buildTrajectory(poses,weak,fusion);const middle=r.corrected.flat().find(p=>p.timestamp===epoch+5000)!;
  assert.equal(middle.source,'arkit-relative');const next=r.corrected.flat().find(p=>p.timestamp===epoch+6000)!;assert.equal(next.source,'gps-anchor');
  assert.equal(JSON.stringify({poses,gps:weak,fusion}),before);
});
test('frame clock reset or device wall clock jump requires a new AR session',()=>{
  for(const changed of [poses.map((p,i)=>({...p,frameTimestamp:i>=50?p.frameTimestamp-42:p.frameTimestamp})),poses.map((p,i)=>({...p,timestamp:i>=50?p.timestamp+2000:p.timestamp}))]) {
    const r=buildTrajectory(changed,gps,fusion);assert.equal(r.alignment.status,'rejected');assert.deepEqual(r.aligned,[]);
  }
});
test('outlier GPS never reanchors corrected path; consecutive fallback points retain fusion geometry',()=>{
  const wrong=gps.map((g,i)=>i===5?{...g,...tmInverse(201500,557500)}:g);
  const r=buildTrajectory(poses,wrong,fusion);assert.equal(r.alignment.status,'aligned');
  assert.equal(r.corrected.flat().find(p=>p.timestamp===epoch+5000)!.source,'arkit-relative');
  const limited=poses.map((p,i)=>({...p,trackingState:i>=40&&i<=60?'limited' as const:p.trackingState}));
  assert.ok(buildTrajectory(limited,gps,fusion).corrected.some(segment=>segment.length>=3&&segment.every(p=>p.source==='existing-fusion')));
});
test('extreme coordinates cannot overflow alignment or produce a false campus map path',()=>{
  assert.throws(()=>parseArkitPose({...message,position:{x:1e308,y:0,z:0}}));
  assert.equal(buildTrajectory(poses,gps.map(g=>({...g,latitude:0,longitude:0})),fusion).alignment.status,'pending');
});
test('one hour at 10Hz remains bounded for a single derived rebuild',t=>{
  const samples=Array.from({length:36000},(_,i)=>({...poses[0],sequence:i,timestamp:epoch+i*100,frameTimestamp:i/10,x:i/100,z:Math.sin(i/1000)*10}));
  const fixes=samples.filter((_,i)=>i%10===0).map(p=>({...gps[0],timestamp:p.timestamp,...tmInverse(201100+c*p.x+s*p.z,557250+s*p.x-c*p.z)}));
  const start=performance.now(),r=buildTrajectory(samples,fixes,[]);const elapsed=performance.now()-start;
  assert.equal(r.alignment.status,'aligned');assert.ok(r.alignment.anchors<=512);assert.equal(r.aligned.flat().length,36000);
  t.diagnostic(`36,000 poses / 3,600 GPS / bounded 512 anchors: ${elapsed.toFixed(1)} ms (synthetic, no DB)`);
});
