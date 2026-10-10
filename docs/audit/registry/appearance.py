"""F07 건물 겉모습: 동 노트 머리의 `겉모습` -> 보정 파일의 "appearance"(화면 표시 전용. 지붕 높이·외곽은 건드리지 않는다).

building_registry.py 가 부른다(write·check 에 함께 들어간다). 노트 양식(건물 규칙서 "동 노트 양식"의 F07 항목):
  겉모습:
    - 대상: [장면 건물 id, ...]     # GET /api/v1/scene 의 buildingId (부분은 "동#부분id", 추가 건물은 "추가-...")
      벽: {값: 붉은 벽돌|유리|밝은 돌|흰 돌|콘크리트|담쟁이|판|금속판, 색: "#rrggbb"(없으면 재질 기본색), 출처, 등급}
      창: {모양: 낱창|띠창|유리벽|아치, 층_표: 층_바닥_높이 안의 이름(은주1관 등. 없으면 동의 표), 색, 덧색(아치 칸의 창 아래 판 색), 출처, 등급}
          층 표가 없는 동: 층수(정수)와 아래_높이(맨 아래 창 줄의 바닥, m)를 적는다. 지붕까지 고르게 나눈다.
      윗벽: {부터_층: "6층" 또는 부터_높이: m, 색, 출처, 등급}
      지붕: {모양: 평지붕|모임지붕, 재질: 기와|콘크리트|유리|옥상 정원|금속판|코트, 색, 오름: m, 들임: m(경사면이 벽에서 안으로 들어가는 거리. 없으면 오름의 1.4배), 지붕창: true, 테두리: "#rrggbb", 출처, 등급}
      특징: [{무엇, 출처, 등급, 그림: 예|아니오}]
등급은 확정·원천·S-MAP·추정 중 하나로 시작해야 한다(겉모습은 표시 전용이라 추정도 싣고, 등급을 그대로 함께 싣는다). 모름은 적지 않는다.
창 줄은 층 표의 층 바닥 높이에 하나씩이다. 층 표에 4층이 있으면 실패한다(학교 건물에는 4층이 없다: 확정).
"""
import re

GRADES = ('확정', '원천', 'S-MAP', '추정')
WALLS = {'붉은 벽돌': 'brick', '유리': 'glass', '밝은 돌': 'stone', '흰 돌': 'white', '콘크리트': 'concrete', '담쟁이': 'ivy', '판': 'panel', '금속판': 'metal'}
STYLES = {'낱창': 'rows', '띠창': 'bands', '유리벽': 'curtain', '아치': 'arches'}
ROOFS = {'평지붕': 'flat', '모임지붕': 'hipped'}
ROOF_MATERIALS = {'기와': 'tile', '콘크리트': 'concrete', '유리': 'glass', '옥상 정원': 'green', '금속판': 'metal', '코트': 'court'}
KEYS = {'벽': 'wall', '창': 'windows', '윗벽': 'upper', '지붕': 'roof'}
COLOR = re.compile(r'^#[0-9a-f]{6}$')


def _grade(v):
    g = str((v or {}).get('등급') or '').strip()
    return next((k for k in GRADES if g.startswith(k)), None)


def floor_table(head, name=None):
    """{층 표기: 바닥 높이} of the note's 층_바닥_높이 (of the named sub-table when the building has several)."""
    t = head.get('층_바닥_높이') or {}
    if name: t = t.get(name) or {}
    return {k: v.get('값') for k, v in (t.get('층') or {}).items() if isinstance(v, dict) and isinstance(v.get('값'), (int, float))}


def from_note(head):
    """([{id, wall, ...}], [problems]) for one note; a note without 겉모습 gives nothing."""
    out, bad = [], []
    for n, e in enumerate(head.get('겉모습') or []):
        at = f'겉모습[{n}]'
        ids = e.get('대상')
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids): bad.append(f'{at}: 대상 은 장면 건물 id 목록'); continue
        grades = {}

        def item(key, required=False):
            v = e.get(key)
            if v is None:
                if required: bad.append(f'{at}: {key} 가 없다')
                return None
            if not isinstance(v, dict) or _grade(v) is None or not v.get('출처'): bad.append(f'{at}.{key}: 출처와 등급(확정·원천·S-MAP·추정)이 있어야 한다'); return None
            grades[KEYS[key]] = str(v['등급'])
            return v

        def color(v, key, to, name):
            c = v.get(key)
            if c is None: return
            if not isinstance(c, str) or not COLOR.match(c): bad.append(f'{at}: {key} 는 "#rrggbb"(소문자)'); return
            to[name] = c

        rec = {}
        w = item('벽', True)
        if w:
            if w.get('값') not in WALLS: bad.append(f"{at}.벽.값 {w.get('값')!r}: {', '.join(WALLS)} 중 하나")
            else: rec['wall'] = WALLS[w['값']]
            color(w, '색', rec, 'wallColor')
        table = None
        win = item('창')
        if win:
            table = floor_table(head, win.get('층_표'))
            if '4층' in table: bad.append(f'{at}.창: 층 표에 4층이 있다(학교 건물에는 4층이 없다)')
            if win.get('모양') not in STYLES: bad.append(f"{at}.창.모양 {win.get('모양')!r}: {', '.join(STYLES)} 중 하나")
            floors = sorted(table.values())
            if not floors:   # no floor table: equal storeys between a stated level and the roof
                count, low, top = win.get('층수'), win.get('아래_높이'), win.get('위_높이')
                if not (isinstance(count, int) and 0 < count < 40 and isinstance(low, (int, float)) and isinstance(top, (int, float)) and top > low):
                    bad.append(f'{at}.창: 층 표가 없는 동은 층수·아래_높이·위_높이 를 적는다')
                else: floors = [round(low + i * (top - low) / count, 2) for i in range(count)]
            if floors and win.get('모양') in STYLES:
                rec['windows'] = {'style': STYLES[win['모양']], 'floorsM': floors}
                color(win, '색', rec['windows'], 'color'); color(win, '덧색', rec['windows'], 'accent')
        up = item('윗벽')
        if up:
            z = up.get('부터_높이')
            if up.get('부터_층') is not None: z = floor_table(head, up.get('층_표')).get(up['부터_층'])
            if not isinstance(z, (int, float)) or not isinstance(up.get('색'), str) or not COLOR.match(up['색']): bad.append(f'{at}.윗벽: 부터_층(층 표에 있는 층) 또는 부터_높이, 그리고 색')
            else: rec['upper'] = {'fromM': z, 'color': up['색']}
        r = item('지붕')
        if r:
            if r.get('모양') not in ROOFS: bad.append(f"{at}.지붕.모양 {r.get('모양')!r}: {', '.join(ROOFS)} 중 하나")
            else:
                roof = {'type': ROOFS[r['모양']]}
                if r.get('재질') is not None:
                    if r['재질'] not in ROOF_MATERIALS: bad.append(f"{at}.지붕.재질 {r['재질']!r}: {', '.join(ROOF_MATERIALS)} 중 하나")
                    else: roof['material'] = ROOF_MATERIALS[r['재질']]
                color(r, '색', roof, 'color'); color(r, '테두리', roof, 'rim')
                if r.get('오름') is not None:
                    if not isinstance(r['오름'], (int, float)) or not 0 < r['오름'] <= 8: bad.append(f'{at}.지붕.오름 은 0~8 m')
                    else: roof['riseM'] = r['오름']
                if r.get('들임') is not None:
                    if not isinstance(r['들임'], (int, float)) or not 0 < r['들임'] <= 10: bad.append(f'{at}.지붕.들임 은 0~10 m')
                    else: roof['runM'] = r['들임']
                if r.get('지붕창') is True: roof['dormers'] = True
                rec['roof'] = roof
        feats = []
        for k, f in enumerate(e.get('특징') or []):
            if not isinstance(f, dict) or not f.get('무엇') or not f.get('출처') or _grade(f) is None or f.get('그림') not in ('예', '아니오'):
                bad.append(f'{at}.특징[{k}]: 무엇·출처·등급·그림(예|아니오)'); continue
            feats.append({'what': f['무엇'], 'evidence': f['출처'], 'grade': str(f['등급']), 'drawn': f['그림'] == '예'})
        rec['grades'] = grades
        if feats: rec['features'] = feats
        out += [{'id': i, **rec} for i in ids]
    return out, bad
