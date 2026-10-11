"""F07 건물 겉모습: 동 노트 머리의 `겉모습` -> 보정 파일의 "appearance"(화면 표시 전용. 지붕 높이·외곽은 건드리지 않는다).

building_registry.py 가 부른다(write·check 에 함께 들어간다). 노트 양식(건물 규칙서 "동 노트 양식"의 F07 항목):
  겉모습:
    - 대상: [장면 건물 id, ...]     # GET /api/v1/scene 의 buildingId (부분은 "동#부분id", 추가 건물은 "추가-...")
      벽: {값: 붉은 벽돌|유리|밝은 돌|흰 돌|콘크리트|담쟁이|판|금속판, 색: "#rrggbb"(없으면 재질 기본색), 출처, 등급}
      창: {모양: 낱창|띠창|유리벽|아치|긴 아치, 층_표: 층_바닥_높이 안의 이름(은주1관 등. 없으면 동의 표), 색, 덧색(아치 칸의 창 아래 판 색), 출처, 등급}
          층 표가 없는 동: 층수(정수)와 아래_높이(맨 아래 창 줄의 바닥, m)를 적는다. 지붕까지 고르게 나눈다.
      윗벽: {부터_층: "6층" 또는 부터_높이: m, 색, 출처, 등급}
      지붕: {모양: 평지붕|모임지붕, 재질: 기와|콘크리트|유리|옥상 정원|금속판|코트, 색, 오름: m, 들임: m(경사면이 벽에서 안으로 들어가는 거리. 없으면 오름의 1.4배), 지붕창: true, 테두리: "#rrggbb", 출처, 등급}
      특징: [{무엇, 출처, 등급, 그림: 예|아니오}]
Z07 에서 더한 것:
      창.모양 "긴 아치": 여러 층을 꿰뚫는 아치 칸 하나(유리 + 층마다 벽 띠 + 둥근 머리).
      창.지붕까지: true     # 층 표가 끝난 위로도 마지막 층 간격의 줄을 벽 꼭대기까지 잇는다(외장의 줄이지 층이 아니다. 층 번호를 만들지 않는다)
      벽면: [{방향: 북|북동|동|남동|남|남서|서|북서 또는 방위각(도, 북 0·동 90), 폭: 도(기본 45), 값: 벽 재질, 색, 창: 창 모양 또는 "없음", 기둥: 개수(그 방향의 가장 긴 벽 가운데에 큰 기둥 열과 보), 기둥_아래_층: 층 표의 층(기둥이 서는 바닥. 없으면 맨 아래 층), 출처, 등급}]
            # 그 방향을 보는 벽면만 다른 재질·창 모양으로 그린다(한 면의 담쟁이, 정면의 기둥 열)
      지붕.처마띠: m     # 처마 밑 벽의 밝은 띠 높이
Z09 에서 더한 것:
      창.모양 "작은 아치": 층마다 머리가 둥근 작은 창.   "기둥 발코니": 층을 꿰뚫는 곧은 기둥 사이에 깊은 발코니(어두운 안쪽, 층마다 난간 띠와 창 띠, 맨 위에 보)
      지붕.겹: 2          # 두 겹 처마(아래 지붕 위에 낮은 벽 띠, 그 위에 작은 윗지붕)
      밑동: {색: "#rrggbb", 위_높이: m(없으면 기초만), 출처, 등급}   # 건물이 올라선 기단·옹벽: 기초와 위_높이 아래 벽을 이 색으로, 창 없이
Z10 에서 더한 것:
      지붕.테두리 가 모임지붕에 있으면 처마(밑면과 가장자리 띠)를 그 색으로 그린다(짙은 금속판 지붕층: 밝은 처마가 없다)
등급은 확정·원천·S-MAP·추정 중 하나로 시작해야 한다(겉모습은 표시 전용이라 추정도 싣고, 등급을 그대로 함께 싣는다). 모름은 적지 않는다.
창 줄은 층 표의 층 바닥 높이에 하나씩이다. 층 표에 4층이 있으면 실패한다(학교 건물에는 4층이 없다: 확정).
"""
import re

GRADES = ('확정', '원천', 'S-MAP', '추정')
WALLS = {'붉은 벽돌': 'brick', '유리': 'glass', '밝은 돌': 'stone', '흰 돌': 'white', '콘크리트': 'concrete', '담쟁이': 'ivy', '판': 'panel', '금속판': 'metal'}
STYLES = {'낱창': 'rows', '띠창': 'bands', '유리벽': 'curtain', '아치': 'arches', '긴 아치': 'bays', '작은 아치': 'archrows', '기둥 발코니': 'piers'}
DIRECTIONS = {'북': 0, '북동': 45, '동': 90, '남동': 135, '남': 180, '남서': 225, '서': 270, '북서': 315}
ROOFS = {'평지붕': 'flat', '모임지붕': 'hipped'}
ROOF_MATERIALS = {'기와': 'tile', '콘크리트': 'concrete', '유리': 'glass', '옥상 정원': 'green', '금속판': 'metal', '코트': 'court'}
KEYS = {'벽': 'wall', '창': 'windows', '윗벽': 'upper', '지붕': 'roof', '밑동': 'plinth'}
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
                if win.get('지붕까지') is True: rec['windows']['toRoof'] = True
        faces = []
        for k, f in enumerate(e.get('벽면') or []):
            fa = f'{at}.벽면[{k}]'
            if not isinstance(f, dict) or _grade(f) is None or not f.get('출처'): bad.append(f'{fa}: 출처와 등급이 있어야 한다'); continue
            d = f.get('방향'); az = DIRECTIONS.get(d) if isinstance(d, str) else d
            if not isinstance(az, (int, float)) or isinstance(az, bool) or not 0 <= az < 360: bad.append(f"{fa}.방향 {d!r}: {', '.join(DIRECTIONS)} 또는 방위각 0~360"); continue
            face = {'azimuth': az, 'grade': str(f['등급'])}
            if f.get('폭') is not None:
                if not isinstance(f['폭'], (int, float)) or not 5 <= f['폭'] <= 90: bad.append(f'{fa}.폭 은 5~90 도'); continue
                face['spread'] = f['폭']
            if f.get('값') is not None:
                if f['값'] not in WALLS: bad.append(f"{fa}.값 {f['값']!r}: {', '.join(WALLS)} 중 하나"); continue
                face['wall'] = WALLS[f['값']]
            color(f, '색', face, 'wallColor')
            if f.get('창') is not None:
                if f['창'] != '없음' and f['창'] not in STYLES: bad.append(f"{fa}.창 {f['창']!r}: {', '.join(STYLES)} 또는 없음"); continue
                face['style'] = 'none' if f['창'] == '없음' else STYLES[f['창']]
            if f.get('기둥') is not None:
                if not isinstance(f['기둥'], int) or not 2 <= f['기둥'] <= 12: bad.append(f'{fa}.기둥 은 2~12 개'); continue
                face['columns'] = f['기둥']
                if f.get('기둥_아래_층') is not None:
                    z = floor_table(head, (e.get('창') or {}).get('층_표')).get(f['기둥_아래_층'])
                    if not isinstance(z, (int, float)): bad.append(f"{fa}.기둥_아래_층 {f['기둥_아래_층']!r}: 층 표에 있는 층"); continue
                    face['columnsFromM'] = z
            if len(face) == 2: bad.append(f'{fa}: 값·색·창·기둥 중 하나는 있어야 한다'); continue
            faces.append(face)
        if faces: rec['faces'] = faces
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
                if r.get('처마띠') is not None:
                    if not isinstance(r['처마띠'], (int, float)) or not 0 < r['처마띠'] <= 4: bad.append(f'{at}.지붕.처마띠 는 0~4 m')
                    else: roof['eaveBandM'] = r['처마띠']
                if r.get('지붕창') is True: roof['dormers'] = True
                if r.get('겹') is not None:
                    if r['겹'] != 2: bad.append(f'{at}.지붕.겹 은 2')
                    else: roof['tiers'] = 2
                rec['roof'] = roof
        pl = item('밑동')
        if pl:
            c, t = pl.get('색'), pl.get('위_높이')
            if not isinstance(c, str) or not COLOR.match(c) or (t is not None and (not isinstance(t, (int, float)) or isinstance(t, bool))): bad.append(f'{at}.밑동: 색("#rrggbb")과, 있으면 위_높이(m)')
            else: rec['plinth'] = {'color': c, **({'topM': t} if t is not None else {})}
        feats = []
        for k, f in enumerate(e.get('특징') or []):
            if not isinstance(f, dict) or not f.get('무엇') or not f.get('출처') or _grade(f) is None or f.get('그림') not in ('예', '아니오'):
                bad.append(f'{at}.특징[{k}]: 무엇·출처·등급·그림(예|아니오)'); continue
            feats.append({'what': f['무엇'], 'evidence': f['출처'], 'grade': str(f['등급']), 'drawn': f['그림'] == '예'})
        rec['grades'] = grades
        if feats: rec['features'] = feats
        out += [{'id': i, **rec} for i in ids]
    return out, bad
