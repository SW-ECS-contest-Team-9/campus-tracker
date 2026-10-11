// Decision logic of the deploy reconcile: compare the database with the desired-state manifest and (mode "on") bring it
// there. No database or file access here: everything goes through ReconcileDeps (reconcile-db.ts has the real ones), so
// the decisions are unit tested (test/deploy-reconcile.test.ts).
//
// Order: migrations -> data files check -> building id corrections -> terrain -> scene. Rules:
// - Before anything is written, the data files of this checkout and the active campus map are compared with the manifest
//   (only when the terrain or scene is not already the wanted one). A difference refuses the whole run.
// - A terrain or scene version is activated ONLY when the id built from the files equals the manifest id. Another id means
//   the files or the campus map on this machine are not what the commit was made with (line endings, footprints): refused,
//   nothing written, the old state keeps being served.
// - The road network is never touched: no road re-levelling, no road/place/area writes. That stays a separate, approved step.
// - Every step is idempotent; a failing step is reported and the following ones are skipped.

export type ReconcileMode = 'on' | 'dry-run' | 'off';
export type Outcome = 'unchanged' | 'applied' | 'pending' | 'refused' | 'failed' | 'skipped';
export type Step = 'migrations' | 'files' | 'buildingIds' | 'terrain' | 'scene';
export interface StepResult { step: Step; outcome: Outcome; detail: string }

export interface ReconcileDeps {
  /** names of the migrations not yet applied; applies them when apply is true */
  migrations(apply: boolean): Promise<string[]>;
  /** done = corrected ids in place, fresh = to rename, half = neither */
  buildingIdState(): Promise<'done' | 'fresh' | 'half'>;
  renameBuildingIds(): Promise<void>;
  activeTerrain(): Promise<string | null>;
  /** builds the terrain from the recipe in memory; activate stores (if absent) and activates it */
  buildTerrain(): Promise<{ id: string; activate(): Promise<void> }>;
  activeScene(): Promise<string | null>;
  /** runs the scene import gates on the active terrain; save replaces and activates that scene */
  planScene(): Promise<{ id: string; save(): Promise<void> }>;
  /** what differs between this checkout (data files, active campus map) and the manifest; [] = nothing */
  preflight(): Promise<string[]>;
}

export async function reconcile(want: { terrainId: string; sceneId: string }, mode: ReconcileMode, deps: ReconcileDeps): Promise<StepResult[]> {
  if (mode === 'off') return [];
  const apply = mode === 'on';
  const results: StepResult[] = [];
  const steps: [Step, () => Promise<[Outcome, string]>][] = [
    ['migrations', async () => {
      const pending = await deps.migrations(apply);
      return pending.length ? [apply ? 'applied' : 'pending', pending.join(', ')] : ['unchanged', ''];
    }],
    ['files', async () => {
      if (await deps.activeTerrain() === want.terrainId && await deps.activeScene() === want.sceneId) return ['unchanged', ''];
      const problems = await deps.preflight();
      return problems.length ? ['refused', problems.join('; ')] : ['unchanged', ''];
    }],
    ['buildingIds', async () => {
      const state = await deps.buildingIdState();
      if (state === 'done') return ['unchanged', ''];
      if (state === 'half') return ['refused', 'half-renamed building ids: neither the campus map file\'s ids nor the corrected ones'];
      if (apply) await deps.renameBuildingIds();
      return [apply ? 'applied' : 'pending', '정정(building-ids.json)'];
    }],
    ['terrain', async () => {
      const active = await deps.activeTerrain();
      if (active === want.terrainId) return ['unchanged', active];
      const built = await deps.buildTerrain();
      if (built.id !== want.terrainId) return ['refused', `the recipe gives ${built.id} here, the manifest says ${want.terrainId} (the building footprints of the active campus map or the code differ)`];
      if (apply) await built.activate();
      return [apply ? 'applied' : 'pending', `${active ?? 'none'} -> ${want.terrainId}`];
    }],
    ['scene', async () => {
      const active = await deps.activeScene();
      if (active === want.sceneId && !results.some((r) => r.outcome === 'pending')) return ['unchanged', active];
      // dry run with earlier steps pending: the scene id depends on the terrain and building ids that are not there yet
      if (results.some((r) => r.outcome === 'pending')) return ['pending', `${active ?? 'none'} -> ${want.sceneId} (not verified: earlier steps are pending)`];
      const plan = await deps.planScene();
      if (plan.id !== want.sceneId) return ['refused', `the import gives ${plan.id} here, the manifest says ${want.sceneId} (the active campus map or terrain differs)`];
      if (apply) await plan.save();
      return [apply ? 'applied' : 'pending', `${active ?? 'none'} -> ${want.sceneId}`];
    }],
  ];
  for (const [step, run] of steps) {
    if (results.some((r) => r.outcome === 'refused' || r.outcome === 'failed')) {
      results.push({ step, outcome: 'skipped', detail: 'an earlier step did not pass' });
      continue;
    }
    try {
      const [outcome, detail] = await run();
      results.push({ step, outcome, detail });
    } catch (err) {
      results.push({ step, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export type ReconcileResult = 'off' | 'in-sync' | 'pending' | 'applied' | 'refused' | 'failed';

export function overall(results: StepResult[], mode: ReconcileMode): ReconcileResult {
  if (mode === 'off') return 'off';
  for (const o of ['failed', 'refused', 'pending', 'applied'] as const) if (results.some((r) => r.outcome === o)) return o;
  return 'in-sync';
}

const NAMES: Record<Step, string> = { migrations: 'DB 이행', files: '자료 파일', buildingIds: '건물 id', terrain: '지형', scene: '건물 장면' };

/** The one summary line (what changed / nothing to do / what was refused and why). */
export function summarize(results: StepResult[], mode: ReconcileMode): string {
  const list = (o: Outcome) => results.filter((r) => r.outcome === o).map((r) => `${NAMES[r.step]} ${r.detail}`.trim()).join(', ');
  switch (overall(results, mode)) {
    case 'off': return '비교하지 않음(DEPLOY_RECONCILE=off)';
    case 'in-sync': return '할 일 없음: DB가 받은 저장소 상태와 같음';
    case 'pending': return `받은 저장소 상태와 DB가 다름: ${list('pending')}. \`npm run deploy:sync\` 로 적용`;
    case 'applied': return `적용함: ${list('applied')}`;
    case 'refused': return `거부(DB는 그대로 둠): ${list('refused')}${list('applied') ? `. 그 전에 적용한 것: ${list('applied')}` : ''}`;
    case 'failed': return `실패(이 단계부터 하지 않음): ${list('failed')}${list('applied') ? `. 그 전에 적용한 것: ${list('applied')}` : ''}`;
  }
}
