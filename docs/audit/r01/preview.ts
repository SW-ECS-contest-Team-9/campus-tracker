/** R01: 조리법으로 지형 후보를 만들어(저장하지 않음) 격자를 파일로 쓴다. 읽기만 한다(READ ONLY 트랜잭션).
 * 쓰는 법(시험용 체크아웃의 backend/ 에서): npx tsx ../docs/audit/r01/preview.ts BASE_VERSION recipe.json OUT.f32
 * 조리법 경로는 다른 체크아웃의 것이어도 된다(입력 파일은 조리법 파일 기준 상대 경로). 바뀐 칸 견줌은 check_cells.py. */
import fs from 'node:fs';
import { pool } from '../../../backend/src/config/database.js';
import { buildRecipeTerrain } from '../../../backend/src/geo/terrain-recipe-build.js';

async function main() {
  const [base, recipe, out] = process.argv.slice(2);
  if (!base || !recipe || !out) throw new Error('Usage: preview.ts BASE_VERSION recipe.json OUT.f32');
  if (!/127\.0\.0\.1:5544/.test(process.env.DATABASE_URL ?? '')) throw new Error('시험용 DB(127.0.0.1:5544)가 아니다');
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const built = await buildRecipeTerrain(db, base, recipe);
    await db.query('ROLLBACK');
    fs.writeFileSync(out, Buffer.from(built.heights.buffer));
    console.log(JSON.stringify({ id: built.id, gridSha256: built.sha, saved: false, steps: built.metadata.steps.map((s) => ({ type: s.type, changedCells: s.changedCells })) }));
  } finally { db.release(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
