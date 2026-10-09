// Run only against a disposable empty PostGIS DB with AREA_TEST_DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { toErrorBody } from '../src/common/errors/app-error.js';

test('areas persist geometry and height; reject invalid shapes and stale edits; delete audited',
  { skip: !process.env.AREA_TEST_DATABASE_URL }, async () => {
    process.env.DATABASE_URL = process.env.AREA_TEST_DATABASE_URL;
    const { pool } = await import('../src/config/database.js');
    const { areaRoutes } = await import('../src/modules/editor/area.routes.js');
    let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE TABLE terrain_versions(active boolean,origin_x float8,origin_y float8,width int,height int,resolution_m float8);
        INSERT INTO terrain_versions VALUES(true,200000,557000,2000,2000,1);`);
      for (const migration of ['019_mobility_spaces.sql','020_mobility_defaults.sql']) {
        await pool.query(await readFile(new URL(`../src/db/migrations/${migration}`, import.meta.url), 'utf8'));
      }
      const app = express(); app.use(express.json()); app.use('/areas-api', areaRoutes);
      app.use((err: unknown,_req: express.Request,res: express.Response,_next: express.NextFunction) => {
        const error = toErrorBody(err); res.status(error.status).json({error:error.body});
      });
      server = app.listen(0,'127.0.0.1');
      await new Promise<void>(resolve=>server!.once('listening',resolve));
      const address = server.address() as {port:number};
      const request = (path: string,method='GET',body?: unknown)=>fetch(`http://127.0.0.1:${address.port}/areas-api${path}`,{
        method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      const body = {name:'계단 앞 로비',kind:'lobby',elevationM:142.5,floor:'B1',
        coordinates:[[201000,557300],[201010,557300],[201010,557310],[201000,557310]]};
      const created = await request('/areas','POST',body); assert.equal(created.status,201);
      const area = await created.json() as any;
      assert.equal(area.areaM2,100); assert.equal(area.elevationM,142.5);
      assert.equal(area.geometry.coordinates[0].length,5);
      assert.equal((await (await request('/areas')).json() as any[]).length,1);
      for (const coordinates of [
        [[201000,557300],[201010,557310],[201010,557300],[201000,557310]],
        [[201000,557300],[201001,557300],[201001,557301]],
        [[210000,557300],[210010,557300],[210010,557310]],
      ]) assert.equal((await request('/areas','POST',{...body,coordinates})).status,400);
      const updated = await request(`/areas/${area.id}`,'PUT',{...body,name:'수정 로비',elevationM:143,expectedRevision:area.revision});
      assert.equal(updated.status,200); const next = await updated.json() as any;
      assert.equal(next.elevationM,143);
      assert.equal((await request(`/areas/${area.id}`,'PUT',{...body,expectedRevision:area.revision})).status,409);
      assert.equal((await request(`/areas/${area.id}`,'DELETE',{expectedRevision:area.revision})).status,409);
      assert.equal((await request(`/areas/${area.id}`,'DELETE',{expectedRevision:next.revision})).status,200);
      assert.equal((await (await request('/areas')).json() as any[]).length,0);
      assert.equal((await pool.query('SELECT count(*) FROM mobility.edits')).rows[0].count,3);
      const holes = [[[201002,557302],[201002,557306],[201006,557306],[201006,557302]]];
      const courtyard = await request('/areas','POST',{...body,holes});
      assert.equal(courtyard.status,201);
      const withHole = await courtyard.json() as any;
      assert.equal(withHole.areaM2,84);
      assert.equal(withHole.geometry.coordinates.length,2);
      const renamed = await request(`/areas/${withHole.id}`,'PUT',{
        ...body,holes,name:'중정 보존 로비',expectedRevision:withHole.revision});
      assert.equal(renamed.status,200);
      const preserved = await renamed.json() as any;
      assert.deepEqual(preserved.geometry.coordinates,withHole.geometry.coordinates);
      assert.equal((await request('/areas','POST',{...body,holes:[[
        [201012,557302],[201012,557306],[201016,557306],[201016,557302],
      ]]})).status,400); // 외곽 밖 구멍은 저장하지 않는다.
    } finally {
      if (server) await new Promise<void>((resolve,reject)=>server!.close(err=>err?reject(err):resolve()));
      await pool.end();
    }
  });
