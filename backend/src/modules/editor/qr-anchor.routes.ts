import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../config/database.js';
import { Uuid } from '../../common/dto.js';
import { AppError } from '../../common/errors/app-error.js';
import { FLOOR_NAME } from '../markers/marker-anchor.js';
import { XYZ } from './editor.dto.js';

export const qrAnchorRoutes = Router();
const fields = `id, label, building_id AS "buildingId", floor, revision,
  json_build_array(ST_X(geom), ST_Y(geom), ST_Z(geom)) AS coordinate`;
export const qrAnchorInput = z.object({ label: z.string().trim().min(1).max(200), buildingId: z.string().trim().regex(/^[^\s#]{1,24}$/),
  floor: z.string().trim().toUpperCase().regex(FLOOR_NAME).nullable(), coordinate: XYZ })
  .refine((v) => v.buildingId === 'outdoor' || v.floor !== null, { message: 'Indoor anchors require a floor', path: ['floor'] });

qrAnchorRoutes.get('/qr-anchors', async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${fields} FROM mobility.qr_anchors ORDER BY label, id`);
  res.setHeader('Cache-Control', 'no-store'); res.json({ anchors: rows });
});
qrAnchorRoutes.post('/qr-anchors', async (req, res) => {
  const b = qrAnchorInput.parse(req.body);
  const { rows } = await pool.query(`INSERT INTO mobility.qr_anchors(label, building_id, floor, geom)
    VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5,$6),5186)) RETURNING ${fields}`,
    [b.label, b.buildingId, b.floor, ...b.coordinate]);
  res.status(201).json(rows[0]);
});
qrAnchorRoutes.put('/qr-anchors/:id', async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const { expectedRevision, ...b } = qrAnchorInput.and(z.object({ expectedRevision: z.number().int().positive() })).parse(req.body);
  const { rows } = await pool.query(`UPDATE mobility.qr_anchors SET label=$2, building_id=$3, floor=$4,
    geom=ST_SetSRID(ST_MakePoint($5,$6,$7),5186), revision=revision+1, updated_at=now()
    WHERE id=$1 AND revision=$8 RETURNING ${fields}`, [id, b.label, b.buildingId, b.floor, ...b.coordinate, expectedRevision]);
  if (!rows[0]) throw AppError.conflict('QR_ANCHOR_CHANGED', 'QR anchor changed or was deleted; refresh and try again.');
  res.json(rows[0]);
});
qrAnchorRoutes.delete('/qr-anchors/:id', async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const { expectedRevision } = z.object({ expectedRevision: z.number().int().positive() }).parse(req.body);
  const { rowCount } = await pool.query('DELETE FROM mobility.qr_anchors WHERE id=$1 AND revision=$2', [id, expectedRevision]);
  if (!rowCount) throw AppError.conflict('QR_ANCHOR_CHANGED', 'QR anchor changed or was deleted; refresh and try again.');
  res.json({ deleted: true });
});
