// 실내 위치 따라가기: 지금 어느 건물에 있는지(없으면 바깥)를 잡음이 있는 위치에서 정한다. 화면에 의존하지 않음(시험 가능).
// - 처음 받은 확실한 위치는 바로 정한다.
// - 다른 건물(또는 바깥)로 바뀌려면 같은 후보가 FOLLOW.fixes 번 이어지거나, FOLLOW.fixesSlow 번 이상이면서 FOLLOW.ms 이상 이어져야 한다.
// - 'uncertain' 위치는 건물을 바꾸지 않는다(마지막 것 유지, 후보도 버림).

export const FOLLOW = { fixes: 3, fixesSlow: 2, ms: 3000 };

export type FollowFix = { t: number; building: string | null; state: 'ok' | 'uncertain' };
export type FollowChange = { from: string | null; to: string | null };

export class BuildingFollow {
  /** 정해진 건물(null = 바깥), undefined = 아직 모름. */
  current: string | null | undefined = undefined;
  private candidate: { building: string | null; since: number; count: number } | null = null;

  /** 위치 하나를 넣는다. 건물이 바뀌었으면 바뀜을 돌려준다. */
  update(fix: FollowFix): FollowChange | null {
    if (fix.state === 'uncertain') { this.candidate = null; return null; }
    if (this.current === undefined) { this.current = fix.building; return { from: null, to: fix.building }; }
    if (fix.building === this.current) { this.candidate = null; return null; }
    if (!this.candidate || this.candidate.building !== fix.building) this.candidate = { building: fix.building, since: fix.t, count: 0 };
    const c = this.candidate;
    c.count++;
    if (c.count >= FOLLOW.fixes || (c.count >= FOLLOW.fixesSlow && fix.t - c.since >= FOLLOW.ms)) {
      const change = { from: this.current, to: c.building };
      this.current = c.building;
      this.candidate = null;
      return change;
    }
    return null;
  }

  reset() { this.current = undefined; this.candidate = null; }
}
