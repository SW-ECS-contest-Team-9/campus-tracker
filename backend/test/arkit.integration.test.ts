// Only an explicitly supplied disposable PostGIS test database is used. Never defaults to .env DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { tmInverse } from '../src/geo/tm.js';

test('ARKit authenticated transports, persistence, replay, preview, reconnect and legacy compatibility', {skip:!process.env.ARKIT_TEST_DATABASE_URL,timeout:60000},async()=>{
  const url=new URL(process.env.ARKIT_TEST_DATABASE_URL!);
  assert.match(url.pathname,/_test$/,'Use a disposable database whose name ends in _test');
  process.env.DATABASE_URL=url.toString();
  const { pool }=await import('../src/config/database.js');
  const { migrate }=await import('../src/db/migrator.js');
  const { signAccessToken }=await import('../src/common/auth/jwt.js');
  const { registerRawCollectorGateway }=await import('../src/realtime/raw-ws.gateway.js');
  const { registerCollectorGateway }=await import('../src/realtime/collector.gateway.js');
  const { registerPreviewGateway }=await import('../src/realtime/preview.gateway.js');
  const { arkitService, stopArkitJobs }=await import('../src/modules/arkit/arkit.service.js');
  const { createApp }=await import('../src/app.js');
  const { REALTIME_FUSION_VERSION }=await import('../src/modules/fusion/fusion.algorithms.js');
  const collector=randomUUID(),device=randomUUID(),session=randomUUID(),legacy=randomUUID(),ar=randomUUID(),ar2=randomUUID();
  const server=http.createServer(createApp()),socketServer=new Server(server,{destroyUpgrade:false});
  const wss=registerRawCollectorGateway(server);registerCollectorGateway(socketServer);registerPreviewGateway(socketServer);
  const sockets:WebSocket[]=[];const sio:ReturnType<typeof io>[]=[];
  const socketOnce=(socket:ReturnType<typeof io>,event:string)=>new Promise<any[]>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timed out: ${event}`)),5000);socket.once(event,(...args:any[])=>{clearTimeout(timer);resolve(args);});});
  try {
    await migrate();
    await pool.query('INSERT INTO collectors(id,collector_code) VALUES($1,$2)',[collector,`AR${collector.slice(0,8)}`]);
    await pool.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)',[device,collector,'arkit-test-phone']);
    for(const id of [session,legacy]) await pool.query('INSERT INTO collection_sessions(id,client_session_id,collector_id,device_id,started_at,status) VALUES($1,$2,$3,$4,$5,\'FINISHED\')',[id,randomUUID(),collector,device,'2026-10-01T00:00:00Z']);
    const identity={collectorId:`AR${collector.slice(0,8)}`,collectorDatabaseId:collector,deviceDatabaseId:device,clientDeviceId:'arkit-test-phone'};
    const token=signAccessToken(identity);
    server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
    const connect=async()=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/ws/collector`,{headers:{Authorization:`Bearer ${token}`,'X-Device-ID':identity.clientDeviceId}});sockets.push(ws);await once(ws,'open');return ws;};
    let ws=await connect();
    const exchange=async(raw:string)=>{const received=once(ws,'message');ws.send(raw);return JSON.parse((await received)[0].toString());};
    const send=(type:string,payload:unknown)=>exchange(JSON.stringify({requestId:randomUUID(),type,payload}));
    const epoch=Date.parse('2026-10-01T00:00:00Z');
    const pose=(sequence:number,arSessionId=ar)=>({type:'arkit.pose',schemaVersion:1,sessionId:session,arSessionId,deviceId:identity.clientDeviceId,sequence,timestamp:epoch+sequence*100,frameTimestamp:sequence/10,position:{x:sequence/5,y:1.5,z:0},rotation:{x:0,y:0,z:0,w:1},trackingState:'normal'});
    assert.equal((await exchange('{')).error.code,'INVALID_JSON');
    for (const value of ['NaN','Infinity']) assert.equal((await exchange(`{"type":"arkit.pose","payload":{"x":${value}}}`)).error.code,'INVALID_JSON');
    assert.equal((await send('arkit.pose',{...pose(0),extra:'x'.repeat(5000)})).error.code,'ARKIT_MESSAGE_SIZE');
    const missing={...pose(0)} as Record<string,unknown>; delete missing.arSessionId;
    assert.equal((await send('arkit.pose',missing)).ok,false);
    assert.equal((await send('arkit.pose',{...pose(0),position:{x:null,y:0,z:0}})).ok,false);
    assert.equal((await send('arkit.pose',{...pose(0),schemaVersion:2})).ok,false);
    assert.equal((await send('arkit.pose',{...pose(0),deviceId:'other'})).error.code,'DEVICE_MISMATCH');
    const foreignDevice=randomUUID();await pool.query('INSERT INTO devices(id,collector_id,client_device_id) VALUES($1,$2,$3)',[foreignDevice,collector,'other']);
    await pool.query('UPDATE collection_sessions SET device_id=$2 WHERE id=$1',[session,foreignDevice]);
    assert.equal((await send('arkit.pose',pose(0))).error.code,'SESSION_DEVICE_MISMATCH');
    await pool.query('UPDATE collection_sessions SET device_id=$2 WHERE id=$1',[session,device]);
    const preview=io(`http://127.0.0.1:${port}/preview`,{transports:['websocket']});sio.push(preview);await socketOnce(preview,'connect');
    const previewPose=socketOnce(preview,'arkit:pose');
    assert.equal((await send('arkit.pose',pose(0))).data.duplicate,false);assert.equal((await previewPose)[0].pose.x,0);
    assert.equal((await send('arkit:pose',pose(0))).data.duplicate,true);
    await new Promise<void>(resolve=>{ws.once('close',()=>resolve());ws.close();});ws=await connect();
    assert.equal((await send('arkit.pose',pose(0))).data.duplicate,true);
    // Timestamp order, not arrival or sequence order. Concurrent retries use the SQL unique key.
    const concurrent=await Promise.all(Array.from({length:5},()=>arkitService.ingest(identity,pose(1))));assert.equal(concurrent.filter(r=>!r.duplicate).length,1);
    for(const i of [100,...Array.from({length:98},(_,i)=>i+2)]) assert.equal((await send('arkit.pose',pose(i))).ok,true);
    assert.equal((await send('arkit.pose',{...pose(0,ar2),trackingState:'limited'})).ok,true);
    const client=io(`http://127.0.0.1:${port}/collector`,{auth:{token,deviceId:identity.clientDeviceId},transports:['websocket']});sio.push(client);await socketOnce(client,'connect');
    assert.equal((await client.emitWithAck('arkit.pose',{...pose(1,ar2),trackingState:'notAvailable'})).ok,true);
    const base=`http://127.0.0.1:${port}/api/v1/sessions/${session}/arkit`;
    let stats=await (await fetch(base)).json() as any;assert.equal(stats.sessions.length,2);assert.equal(stats.sessions.find((s:any)=>s.arSessionId===ar).poseCount,101);
    const raw=await (await fetch(`${base}/${ar}/poses?limit=2`)).json() as any;assert.equal(raw.poses.length,2);assert.ok(raw.nextAfterId);assert.ok(raw.poses[0].rotationW===1);
    const next=await (await fetch(`${base}/${ar}/poses?afterId=${raw.nextAfterId}&limit=2`)).json() as any;assert.ok(next.poses[0].id>raw.nextAfterId);
    await arkitService.reprocess(session);stats=await (await fetch(base)).json() as any;assert.equal(stats.sessions.find((s:any)=>s.arSessionId===ar).result.alignment.status,'pending');
    // Existing collector still stores all four streams, with no ARKit payload fields required.
    const locations=Array.from({length:11},(_,i)=>({...tmInverse(201100+i*2,557250),sequence:i,timestamp:new Date(epoch+i*1000).toISOString(),horizontalAccuracy:2,verticalAccuracy:2,altitude:101.5}));
    const batch=(id:string)=>({batchId:randomUUID(),sessionId:id,locations,motion:[{sequence:0,timestamp:new Date(epoch).toISOString(),userAcceleration:{x:0,y:0,z:0}}],altimeter:[{sequence:0,timestamp:new Date(epoch).toISOString(),relativeAltitude:0,pressure:101}],pedometer:[{timestamp:new Date(epoch).toISOString(),numberOfSteps:0}]});
    for(const id of [session,legacy]) assert.equal((await send('telemetry:batch',batch(id))).ok,true);
    assert.equal((await pool.query('SELECT count(*) FROM arkit_sessions WHERE session_id=$1',[legacy])).rows[0].count,0);
    // A stored existing fusion path is immutable across the separate derived pipeline.
    for(let i=0;i<=10;i++) {const g=locations[i];await pool.query(`INSERT INTO fused_positions(session_id,fusion_sequence,timestamp,latitude,longitude,ellipsoidal_altitude,horizontal_confidence,vertical_confidence,overall_confidence,position_source,algorithm_version,geom)
      VALUES($1,$2,$3,$4,$5,125,1,1,1,'GPS_ANCHORED',$6,ST_SetSRID(ST_MakePoint($5,$4,125),4326))`,[session,i,g.timestamp,g.latitude,g.longitude,REALTIME_FUSION_VERSION]);}
    const before=(await pool.query('SELECT row_to_json(f) AS row FROM fused_positions f WHERE session_id=$1 ORDER BY id',[session])).rows;
    const updated=socketOnce(preview,'arkit:updated');await arkitService.reprocess(session);assert.equal((await updated)[0].sessionId,session);
    stats=await (await fetch(base)).json() as any;const result=stats.sessions.find((s:any)=>s.arSessionId===ar).result;
    assert.equal(result.alignment.status,'aligned');assert.ok(result.alignment.rms<0.01);assert.ok(result.corrected.length);
    const geom=(await pool.query('SELECT ST_SRID(aligned_geom) AS srid,ST_NumGeometries(aligned_geom) AS parts FROM arkit_trajectory_results WHERE session_id=$1 AND ar_session_id=$2',[session,ar])).rows[0];assert.equal(geom.srid,5186);assert.equal(geom.parts,1);
    assert.equal((await pool.query('SELECT aligned_geom IS NULL AS local FROM arkit_trajectory_results WHERE session_id=$1 AND ar_session_id=$2',[session,ar2])).rows[0].local,true);
    assert.deepEqual((await pool.query('SELECT row_to_json(f) AS row FROM fused_positions f WHERE session_id=$1 ORDER BY id',[session])).rows,before);
    for(const table of ['location_samples','motion_samples','altimeter_samples','pedometer_samples']) assert.ok((await pool.query(`SELECT count(*) FROM ${table} WHERE session_id=$1`,[legacy])).rows[0].count>0);
    assert.equal((await fetch(`${base}/${ar}/poses?from=NaN`)).status,400);
  } finally {
    const { fusionService } = await import('../src/modules/fusion/fusion.service.js');
    fusionService.forget([session,legacy]);
    stopArkitJobs();for(const client of sio) client.disconnect();for(const ws of sockets) ws.terminate();
    await new Promise<void>(resolve=>socketServer.close(()=>resolve()));wss.close();if(server.listening) await new Promise<void>(resolve=>server.close(()=>resolve()));
    await pool.end();
  }
});
