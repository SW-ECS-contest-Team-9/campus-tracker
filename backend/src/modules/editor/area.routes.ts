import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { AreaSave, areaPolygon } from './area.dto.js';
import { editorBroadcast } from '../../realtime/editor.gateway.js';

// Mounted after editorAuth. Reuse the QGIS area table, its geometry checks and edit notifications.
export const areaRoutes = Router();
const Id = z.coerce.number().int().positive();
const Revision = z.string().regex(/^\d+$/);
const select = `SELECT id, name, kind, elevation_m "elevationM", building_id "buildingId", floor, note,
  xmin::text revision, ST_Area(geom) "areaM2", ST_AsGeoJSON(geom)::json geometry FROM mobility.open_areas`;

areaRoutes.get('/areas', async (_req, res) => {
  res.json((await pool.query(`${select} ORDER BY id`)).rows);
});
areaRoutes.post('/areas', async (req, res) => {
  const b = AreaSave.parse(req.body);
  const area = await save(b);
  editorBroadcast.areasChanged();
  res.status(201).json(area);
});
areaRoutes.put('/areas/:id', async (req, res) => {
  const b = AreaSave.extend({ expectedRevision: Revision }).parse(req.body);
  const area = await save(b, Id.parse(req.params.id), b.expectedRevision);
  editorBroadcast.areasChanged();
  res.json(area);
});
areaRoutes.delete('/areas/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const { expectedRevision } = z.object({ expectedRevision: Revision }).parse(req.body);
  const result = await pool.query('DELETE FROM mobility.open_areas WHERE id=$1 AND xmin::text=$2 RETURNING id', [id, expectedRevision]);
  if (!result.rowCount) throw AppError.conflict('AREA_CHANGED', '공간이 수정되거나 삭제됐습니다. 목록을 새로고침하세요.');
  editorBroadcast.areasChanged();
  res.json({ id });
});

async function save(b: z.infer<typeof AreaSave>, id?: number, revision?: string) {
  return withTransaction(async db => {
    const geometry = JSON.stringify(areaPolygon(b.coordinates, b.holes));
    const { rows: checks } = await db.query(`SELECT ST_IsValid(g) valid, ST_Area(g) area,
      EXISTS (SELECT 1 FROM terrain_versions t WHERE t.active AND ST_Covers(
        ST_MakeEnvelope(t.origin_x,t.origin_y,t.origin_x+t.width*t.resolution_m,t.origin_y+t.height*t.resolution_m,5186),g)) covered
      FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),5186) g) p`, [geometry]);
    if (!checks[0].valid || checks[0].area < 4 || !checks[0].covered) {
      throw AppError.badRequest('INVALID_AREA', '공간은 캠퍼스 안의 자기 교차 없는 4㎡ 이상 다각형이어야 합니다.');
    }
    const values = [b.name,b.kind,b.elevationM,b.buildingId || null,b.floor || null,b.note || null,geometry];
    const result = id === undefined
      ? await db.query(`INSERT INTO mobility.open_areas(name,kind,elevation_m,building_id,floor,note,geom)
          VALUES($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_GeomFromGeoJSON($7),5186)) RETURNING id`, values)
      : await db.query(`UPDATE mobility.open_areas SET name=$1,kind=$2,elevation_m=$3,building_id=$4,floor=$5,note=$6,
          geom=ST_SetSRID(ST_GeomFromGeoJSON($7),5186) WHERE id=$8 AND xmin::text=$9 RETURNING id`, [...values,id,revision]);
    if (!result.rowCount) throw AppError.conflict('AREA_CHANGED', '공간이 수정되거나 삭제됐습니다. 목록을 새로고침하세요.');
    return (await db.query(`${select} WHERE id=$1`, [result.rows[0].id])).rows[0];
  });
}
