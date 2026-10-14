// What the preview is allowed to claim about a fused point, a run and a session (pure: no Cesium, no DOM).
// Rules: a height without a vertical datum is a DRAWING height, not a floor; a heading that was never fitted is
// unknown; "active with no recent data" is not "finished"; nothing here is a measured position accuracy.

/** Phone carried ~1 m above the ground: where a point without an absolute height is drawn on the terrain. */
export const GROUND_PROJECTION_OFFSET_M = 1;

export type HeightKind =
  | 'ABSOLUTE' // the engine found a vertical datum: this is the estimated height
  | 'GROUND_PROJECTED' // no datum: drawn on the terrain so it is visible; says nothing about the floor
  | 'FALLBACK'; // no datum and no terrain under the point: drawn at a borrowed height

export interface FusedHeightInput {
  ellipsoidalAltitude: number | null;
  terrainHeight?: number | null;
  zDatumSource?: string | null;
  zDatumSigma?: number | null;
  relativeAltitude?: number | null;
  heightAboveGround?: number | null;
}

/** Height a fused point is DRAWN at and what that height means. sceneHeight: ellipsoidal -> scene (MSL). */
export function fusedDisplayHeight(p: FusedHeightInput, fallbackH: number, sceneHeight: (ellipsoidal: number) => number): { h: number; kind: HeightKind } {
  if (p.ellipsoidalAltitude != null) return { h: sceneHeight(p.ellipsoidalAltitude), kind: 'ABSOLUTE' };
  if (p.terrainHeight != null) return { h: p.terrainHeight + GROUND_PROJECTION_OFFSET_M, kind: 'GROUND_PROJECTED' };
  return { h: fallbackH, kind: 'FALLBACK' };
}

export const hasAbsoluteHeight = (p: FusedHeightInput) => p.ellipsoidalAltitude != null;

/**
 * Consecutive points with the same height kind (absolute vs not), each run starting with the last point of the
 * previous one so the drawn line has no hole where the kind changes.
 */
export function splitByAbsoluteHeight<T extends FusedHeightInput>(points: T[]): { absolute: boolean; points: T[] }[] {
  const runs: { absolute: boolean; points: T[] }[] = [];
  for (const p of points) {
    const absolute = hasAbsoluteHeight(p);
    const last = runs.at(-1);
    if (last && last.absolute === absolute) last.points.push(p);
    else runs.push({ absolute, points: last ? [last.points.at(-1)!, p] : [p] });
  }
  return runs;
}

export interface HeightSummary {
  kind: HeightKind;
  /** one line for labels / tooltips */
  status: string;
  /** datum line: where the absolute height comes from and how uncertain it is */
  datum: string;
  /** whether a floor may be named for this point */
  floorAllowed: boolean;
}

const m = (v: number | null | undefined, d = 1) => (v == null ? '–' : `${v.toFixed(d)} m`);

export function describeFusedHeight(p: FusedHeightInput): HeightSummary {
  if (p.ellipsoidalAltitude != null) {
    const datum = p.zDatumSource === 'TERRAIN'
      ? `지면 접촉 기준 (TERRAIN) ±${m(p.zDatumSigma)}`
      : p.zDatumSource === 'GPS'
        ? `GPS 고도 기준 ±${m(p.zDatumSigma)} — 실외 지면 접촉 없음`
        : p.zDatumSource === 'GPS_FALLBACK'
          ? `임시 GPS 기준 ±${m(p.zDatumSigma)} — 신뢰 기준 미충족, 수직 오차가 가장 작은 샘플`
          : '기준 미기록';
    const provisional = p.zDatumSource === 'GPS_FALLBACK';
    return { kind: 'ABSOLUTE', status: provisional ? '절대 고도 임시 추정' : '절대 고도 추정', datum, floorAllowed: !provisional };
  }
  const projected = p.terrainHeight != null;
  return {
    kind: projected ? 'GROUND_PROJECTED' : 'FALLBACK',
    status: projected ? '절대 고도 미확정 · 지면에 투영해 표시' : '절대 고도 미확정 · 지형 정보 없음(임시 높이로 표시)',
    datum: '없음 (지면 접촉·일관된 GPS 고도를 얻지 못함)',
    floorAllowed: false,
  };
}

/** v4: outputs carry the engine's relative Z (barometer, continued over sensor restarts) — not the raw sensor value. */
export function relativeAltitudeLabel(algorithmVersion: string): string {
  return algorithmVersion === 'fusion-v4' ? '상대 Z (기압, 센서 재시작 구간 연결)' : '상대 고도 (기압 원시값)';
}

export interface HeadingInput { heading: number | null; headingSource?: string | null }
export function describeHeading(p: HeadingInput): { known: boolean; text: string } {
  const src = p.headingSource ?? null;
  if (p.heading == null || src === 'UNKNOWN' || src === 'NONE') return { known: false, text: '방향 미확정 (GPS 궤적 맞춤 전) — 이 구간의 걸음은 위치를 옮기지 못함' };
  const how = src === 'GPS_SHAPE_FIT' ? 'GPS 궤적 맞춤' : src === 'CONTINUITY' ? '직전 구간 방향을 이어받음(가정)' : (src ?? '출처 미기록');
  return { known: true, text: `${p.heading.toFixed(0)}° · ${how}` };
}

// ---------------- run stage ----------------

export type TrackStage = 'REALTIME' | 'FORWARD_SENSOR_TIME' | 'FORWARD_AS_RECEIVED' | 'FINAL_SMOOTHED';
export const STAGE_LABEL: Record<TrackStage, string> = {
  REALTIME: '실시간 (도착 순서, 누적)',
  FORWARD_SENSOR_TIME: '시간순 전방 (평활화 전)',
  FORWARD_AS_RECEIVED: '수신 순서 전방 (실시간 재현)',
  FINAL_SMOOTHED: '최종 평활화',
};

export interface RunStageInput {
  mode: 'SENSOR_TIME' | 'AS_RECEIVED';
  trigger?: string | null;
  metrics?: { replay?: { finalizeApplied?: boolean; continuesLive?: boolean; input?: { cutoff?: string | null } } | null; terrain?: unknown } | null;
}

/**
 * Which stage a run's stored (FINAL-slot) track is. Runs made before the replay record existed are classified
 * from what they stored: only a smoothed v4 run has a terrain summary.
 */
export function runStage(run: RunStageInput): TrackStage {
  if (run.mode === 'AS_RECEIVED') return 'FORWARD_AS_RECEIVED';
  const replay = run.metrics?.replay;
  if (replay && typeof replay.finalizeApplied === 'boolean') return replay.finalizeApplied ? 'FINAL_SMOOTHED' : 'FORWARD_SENSOR_TIME';
  return run.metrics?.terrain ? 'FINAL_SMOOTHED' : 'FORWARD_SENSOR_TIME';
}

/** Stage of the PUBLISHED track of a session (what the main preview draws). */
export function publishedStage(session: { status: string }, run: RunStageInput | null, appendedSinceRun: boolean): { stage: TrackStage; note: string } {
  if (!run) return { stage: 'REALTIME', note: '재처리 기록 없음: 도착 순서대로 누적된 실시간 결과' };
  const stage = runStage(run);
  if (stage === 'FINAL_SMOOTHED') return { stage, note: '전체 데이터로 방향 재추정·평활화한 결과' };
  if (session.status === 'ACTIVE') {
    return { stage, note: appendedSinceRun ? '마지막 재처리(시간순) 뒤로는 실시간 결과가 이어 붙음 · 종료 전이라 평활화 안 됨' : '수집 중(ACTIVE)이라 평활화 전 결과 · 종료 후의 최종 결과와 직접 비교 불가' };
  }
  return { stage, note: '평활화 전 결과' };
}

// ---------------- session state ----------------

export interface SessionStateInput {
  status: string;
  syncState?: string | null;
  interrupted?: boolean;
  finishRequestedAt?: string | null;
  finalizedAt?: string | null;
  lastReceivedAt?: string | null;
  lastCapturedAt?: string | null;
  outOfOrderBatches?: number;
  needsReprocess?: boolean;
  fusionState?: string | null;
  raw?: { syncManifest?: { synchronized?: boolean; comparedAt?: string; streams?: Record<string, { expected: number | null; server: number | null; synchronized: boolean }> } | null } | null;
}

export interface StateLine { label: string; tone: 'ok' | 'warn' | 'muted'; text: string }

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
};

/**
 * Collection, finish request, sync manifest and finalization as separate facts. The server never knows how many
 * samples still wait on the phone: without a manifest that is stated, not shown as zero.
 */
export function sessionStateLines(s: SessionStateInput, now: number): StateLine[] {
  const lines: StateLine[] = [];
  const sinceReceive = s.lastReceivedAt ? now - Date.parse(s.lastReceivedAt) : null;
  if (s.status === 'ACTIVE') {
    const quiet = s.syncState === 'OFFLINE' || s.syncState === 'DELAYED';
    lines.push({
      label: '수집', tone: quiet ? 'warn' : 'ok',
      text: quiet
        ? `ACTIVE · 최근 수신 없음${sinceReceive !== null ? ` (${duration(sinceReceive)} 전 마지막 수신)` : ' (수신 기록 없음)'} — 종료가 아님: 오프라인 수집 중이거나 앱이 멈췄을 수 있음`
        : 'ACTIVE · 수신 중',
    });
  } else {
    lines.push({ label: '수집', tone: 'muted', text: `${s.status}${s.interrupted ? ' (센서 연속성 끊김)' : ''}` });
  }
  lines.push(s.finishRequestedAt
    ? { label: '종료 요청', tone: 'ok', text: `수신함 (${new Date(s.finishRequestedAt).toLocaleTimeString()})` }
    : { label: '종료 요청', tone: s.status === 'ACTIVE' ? 'warn' : 'muted', text: s.status === 'ACTIVE' ? '받지 못함 — 사용자가 Stop을 눌렀는지 서버는 알 수 없음' : '기록 없음 (다른 세션 시작으로 중단 처리됨)' });
  const manifest = s.raw?.syncManifest ?? null;
  if (manifest) {
    const behind = Object.entries(manifest.streams ?? {}).filter(([, v]) => !v.synchronized).map(([k, v]) => `${k} ${v.server ?? '없음'}/${v.expected ?? '?'}`);
    lines.push(manifest.synchronized
      ? { label: '동기화', tone: 'ok', text: '폰이 보고한 마지막 순번까지 모두 저장됨' }
      : { label: '동기화', tone: 'warn', text: `미동기화: ${behind.join(', ') || '일부 스트림'} (서버 저장/폰 보고)` });
  } else if (s.raw !== undefined) {
    lines.push({ label: '동기화', tone: 'warn', text: '폰의 동기화 보고(manifest) 없음 — 폰에 남은 미전송 데이터 수는 알 수 없음' });
  }
  if (s.outOfOrderBatches) lines.push({ label: '수신 순서', tone: 'warn', text: `역순 배치 ${s.outOfOrderBatches}개 (실시간 결과에서 누락됐을 수 있음, 원시 데이터는 보존)` });
  if (s.fusionState) {
    const tone = s.fusionState === 'CLEAN' ? 'ok' : 'warn';
    const final = s.finalizedAt ? `최종화 ${new Date(s.finalizedAt).toLocaleTimeString()}` : s.status === 'ACTIVE' ? '최종화 전 (종료 후 실행)' : '최종화 대기';
    lines.push({ label: '융합', tone, text: `${s.fusionState}${s.needsReprocess ? ' · 재처리 필요' : ''} · ${final}` });
  }
  return lines;
}
