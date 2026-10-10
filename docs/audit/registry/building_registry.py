"""건물 규칙서 연결: 동 노트 머리(YAML) -> 서버 건물 보정 파일(backend/data/scene/overrides/building-roofs.json).

  python docs/audit/registry/building_registry.py write [--notes <동 노트 폴더>] [--overrides <보정 파일>]
  python docs/audit/registry/building_registry.py check [--notes <동 노트 폴더>] [--overrides <보정 파일>]

- write: 노트에서 보정 파일을 다시 만든다(동 이름 순, 근거 블록은 노트의 것을 그대로 옮김).
- check: 노트가 말하는 보정과 파일을 동별로 비교한다. 하나라도 다르거나, 모델에 넣는 값의 등급이 확정·원천·S-MAP 이 아니면 종료 코드 1.
노트 폴더(Obsidian 볼트)는 서버에 없다. 서버는 커밋된 보정 파일만 읽는다. 보정 파일은 손으로 고치지 않는다.

노트 머리에서 읽는 항목(건물 규칙서 "동 노트 양식"):
  모델_보정: {종류: 지붕|부분|숨김|없음, 원천_이름, 높이_출처, 층수: {값, 등급}, 사유, 등급, 덮지_않는_곳, 근거: {source, collectedOn, level, independentSurvey, ...}}
  부분[]: 모델_반영: "예" | "아니오 (이유)", 모델_부분: {id, 표지, 지면과_같은_지붕}, 외곽: {좌표: [고리, ...], 등급}, 지붕_높이: {값, 등급}
  덮지_않는_곳(글): 부분들이 원천 외곽을 다 덮지 않을 때 나머지가 무엇인지(-> uncovered). 없으면 빈틈없이 덮어야 한다.
  지면과_같은_지붕(글): 그 부분의 지붕이 외곽선의 가장 높은 땅보다 낮아도 되는 이유(-> terrace). 없으면 지붕이 땅보다 높아야 한다.
  모델_추가: {건물_id, 높이_출처, 층수: {값, 등급}, 대장_id, 근거}: 원천 파일과 캠퍼스 지도에 없는 건물을 새로 넣는다(-> added). 이름표는 노트의 이름.
    외곽과 지붕은 모델_반영 예인 부분 하나의 외곽.좌표·지붕_높이. 이때 모델_보정은 숨김(같은 이름의 잘못 놓인 원천 도형) 또는 없음이어야 한다.
"""
import argparse, json, pathlib, re, sys
import yaml

ABOUT = ('Overrides applied by scripts/scene-import.ts (see src/modules/scene/scene-overrides.ts): "buildings" = roof elevation of one building, '
         '"hidden" = a GeoPackage building that is not drawn, "parts" = one footprint drawn as several flat-roofed blocks, "added" = a building that is not in the GeoPackage or the campus map (scene only). Remove an entry, or import '
         'with --no-overrides, to get the GeoPackage model back. S-MAP is not an independent survey: values here agree with S-MAP, not with a field measurement.')
GENERATED = 'Generated from the building notes by docs/audit/registry/building_registry.py (write); do not edit by hand.'
ALLOWED = ('확정', '원천', 'S-MAP')
DEFAULT_NOTES = r'C:\campus-tracker-backend\데이터\모델링 개선\건물'
DEFAULT_OVERRIDES = pathlib.Path(__file__).resolve().parents[3] / 'backend/data/scene/overrides/building-roofs.json'


def read_head(text):
    """The YAML head of a note (between the first two '---' lines)."""
    if not text.startswith('---'):
        raise ValueError('no YAML head')
    head = text.split('\n---', 1)[0][3:]
    return yaml.safe_load(head)


def grade(v):
    """'확정(있다는 사실만)' -> '확정'; anything that is not a mapping with 등급 -> None."""
    g = v.get('등급') if isinstance(v, dict) else None
    return re.split(r'[\s(,]', str(g).strip(), maxsplit=1)[0] if g is not None else None


def in_model(part):
    v = part.get('모델_반영')
    if not isinstance(v, str) or not (v.startswith('예') or v.startswith('아니오')):
        raise ValueError(f"부분 '{part.get('이름')}': 모델_반영 은 '예' 또는 '아니오 (이유)'")
    if v.startswith('아니오') and len(v.strip()) <= len('아니오'):
        raise ValueError(f"부분 '{part.get('이름')}': 모델_반영 아니오에는 이유를 적는다")
    return v.startswith('예')


def bad_evidence(ev):
    return not isinstance(ev, dict) or not all(isinstance(ev.get(k), str) and ev.get(k) for k in ('source', 'collectedOn', 'level')) or not isinstance(ev.get('independentSurvey'), bool)


def floors_of(m, problems):
    """{'floors': n} from 층수: {값, 등급}, or {} when the note states none."""
    f = m.get('층수')
    if f is None: return {}
    if grade(f) not in ALLOWED: problems.append(f"층수의 등급 {f.get('등급') if isinstance(f, dict) else None!r} 은 모델에 넣을 수 없다")
    if not isinstance(f, dict) or not isinstance(f.get('값'), int): problems.append('모델_보정.층수.값 은 정수'); return {}
    return {'floors': f['값']}


def part_grades(p, problems):
    if grade(p.get('지붕_높이')) not in ALLOWED: problems.append(f"부분 '{p.get('이름')}': 지붕_높이 등급 {grade(p.get('지붕_높이'))!r} 은 모델에 넣을 수 없다")
    if not isinstance((p.get('지붕_높이') or {}).get('값'), (int, float)): problems.append(f"부분 '{p.get('이름')}': 지붕_높이.값 이 숫자가 아니다")
    if grade(p.get('외곽')) not in ALLOWED: problems.append(f"부분 '{p.get('이름')}': 외곽 등급 {grade(p.get('외곽'))!r} 은 모델에 넣을 수 없다")


def added_from_note(head, used):
    """(entry, problems) of 모델_추가: a building that has no source polygon, drawn from the one part that is in the model."""
    a = head.get('모델_추가'); problems = []
    if not isinstance(a, dict): return None, ['모델_추가 는 {건물_id, 높이_출처, 근거, ...}']
    if (head.get('모델_보정') or {}).get('종류') not in ('숨김', '없음'): problems.append('모델_추가 가 있으면 모델_보정.종류 는 숨김 또는 없음(원천 도형이 없는 건물)')
    if not a.get('건물_id'): problems.append('모델_추가.건물_id 가 없다')
    if not head.get('이름'): problems.append('이름 이 없다')
    if bad_evidence(a.get('근거')): problems.append('모델_추가.근거 에 source, collectedOn, level, independentSurvey 가 있어야 한다')
    if len(used) != 1: return None, problems + [f'모델_추가 는 모델_반영 예인 부분이 하나여야 한다({len(used)}개)']
    floors = floors_of(a, problems)
    part_grades(used[0], problems)
    rings = (used[0].get('외곽') or {}).get('좌표')
    if not isinstance(rings, list) or not rings: problems.append(f"부분 '{used[0].get('이름')}': 외곽.좌표 가 있어야 한다(원천 도형이 없다)")
    if problems: return None, problems
    return {'id': str(a['건물_id']), 'name': head['이름'], 'roofM': used[0]['지붕_높이']['값'], 'heightSource': a.get('높이_출처'), **floors,
            **({'registerId': str(a['대장_id'])} if a.get('대장_id') is not None else {}), 'polygon': rings, 'evidence': a['근거']}, problems


def entry_from_note(head):
    """(section, entry, problems, added entry) for one note; section is 'buildings' | 'hidden' | 'parts' | None."""
    name = head.get('이름'); problems = []
    parts = head.get('부분') or []
    used = []
    for p in parts:
        try:
            if in_model(p): used.append(p)
        except ValueError as e:
            problems.append(str(e))
    added = None
    if head.get('모델_추가') is not None:   # its part belongs to the added building, not to a source polygon
        added, bad = added_from_note(head, used)
        problems += bad; used = []
    section, entry, problems = source_entry(head, used, problems)
    return section, entry, problems, added


def source_entry(head, used, problems):
    m = head.get('모델_보정')
    if not isinstance(m, dict) or m.get('종류') not in ('지붕', '부분', '숨김', '없음'):
        return None, None, problems + ['모델_보정.종류 가 없다(지붕·부분·숨김·없음)']
    kind = m['종류']
    if kind == '없음':
        if used: problems.append("모델_보정.종류 가 없음인데 모델_반영 예인 부분이 있다")
        return None, None, problems
    src = m.get('원천_이름')
    ev = m.get('근거')
    if not src: problems.append('모델_보정.원천_이름 이 없다')
    if bad_evidence(ev):
        problems.append('모델_보정.근거 에 source, collectedOn, level, independentSurvey 가 있어야 한다')
    if kind == '숨김':
        if used: problems.append('숨김인데 모델_반영 예인 부분이 있다')
        if grade(m) not in ALLOWED: problems.append(f"숨김의 등급 {m.get('등급')!r} 은 모델에 넣을 수 없다")
        if not m.get('사유'): problems.append('숨김에는 사유를 적는다')
        return 'hidden', {'name': src, 'reason': m.get('사유'), 'evidence': ev}, problems
    floors = floors_of(m, problems)
    for p in used: part_grades(p, problems)
    if problems: return None, None, problems
    if kind == '지붕':
        if len(used) != 1: return None, None, [f'지붕 보정은 모델_반영 예인 부분이 하나여야 한다({len(used)}개)']
        return 'buildings', {'name': src, 'roofM': used[0]['지붕_높이']['값'], 'heightSource': m.get('높이_출처'), **floors, 'evidence': ev}, problems
    out = []
    for p in used:
        mp = p.get('모델_부분') or {}
        rings = (p.get('외곽') or {}).get('좌표')
        if not mp.get('id') or not isinstance(rings, list) or not rings:
            problems.append(f"부분 '{p.get('이름')}': 모델_부분.id 와 외곽.좌표 가 있어야 한다")
            continue
        out.append({'id': str(mp['id']), 'name': mp.get('표지'), 'roofM': p['지붕_높이']['값'], 'polygon': rings, **({'terrace': mp['지면과_같은_지붕']} if mp.get('지면과_같은_지붕') else {})})
    if len(out) < 2: problems.append('부분 보정은 모델_반영 예인 부분이 둘 이상이어야 한다')
    return 'parts', {'name': src, 'heightSource': m.get('높이_출처'), **floors, **({'uncovered': m['덮지_않는_곳']} if m.get('덮지_않는_곳') else {}), 'evidence': ev, 'parts': out}, problems


def build(notes_dir):
    """(document, {note name: [problems]}) from every *.md in the folder."""
    doc = {'about': ABOUT, 'generated': GENERATED, 'buildings': [], 'hidden': [], 'parts': [], 'added': []}
    problems = {}
    for path in sorted(pathlib.Path(notes_dir).glob('*.md')):
        try:
            head = read_head(path.read_text(encoding='utf-8'))
            section, entry, bad, added = entry_from_note(head)
        except Exception as e:  # a note that cannot be read is a failure, not a skipped building
            problems[path.stem] = [f'읽지 못함: {e}']
            continue
        if bad: problems[path.stem] = bad
        else:
            if section: doc[section].append(entry)
            if added: doc['added'].append(added)
    for k in ('buildings', 'hidden', 'parts', 'added'): doc[k].sort(key=lambda e: e['name'])
    return doc, problems


def dumps(doc):
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    text = re.sub(r'\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]', r'[\1, \2]', text)   # each ring on one line (the file is read by people)
    text = re.sub(r'\],\s+\[(?=\d)', '], [', text)
    return text + '\n'


def diff(expected, actual):
    """Per-building differences between the document the notes give and the stored file."""
    out = {}
    add = lambda name, msg: out.setdefault(name, []).append(msg)
    for sec, label in (('buildings', '지붕 보정'), ('hidden', '숨김'), ('parts', '부분 나누기'), ('added', '건물 추가')):
        e = {x['name']: x for x in expected.get(sec, [])}; a = {x.get('name'): x for x in actual.get(sec, []) or []}
        for n in e.keys() - a.keys(): add(n, f'{label}: 노트에는 있고 파일에는 없다')
        for n in a.keys() - e.keys(): add(n, f'{label}: 파일에는 있고 노트에는 없다(노트 등급이 낮거나 모델_반영 아니오)')
        for n in e.keys() & a.keys():
            x, y = e[n], a[n]
            for k in sorted((x.keys() | y.keys()) - {'parts', 'evidence', 'polygon'}):
                if x.get(k) != y.get(k): add(n, f'{label} {k}: 노트 {x.get(k)!r} / 파일 {y.get(k)!r}')
            if x.get('evidence') != y.get('evidence'): add(n, f'{label}: 근거 블록이 다르다')
            if x.get('polygon') != y.get('polygon'): add(n, f'{label}: 외곽 좌표가 다르다')
            if sec == 'parts':
                px = {p['id']: p for p in x['parts']}; py = {p.get('id'): p for p in y.get('parts', [])}
                if [p['id'] for p in x['parts']] != [p.get('id') for p in y.get('parts', [])]: add(n, f"부분 순서·목록: 노트 {list(px)} / 파일 {list(py)}")
                for i in px.keys() & py.keys():
                    for k in ('name', 'roofM', 'terrace'):
                        if px[i].get(k) != py[i].get(k): add(n, f'부분 {i} {k}: 노트 {px[i].get(k)!r} / 파일 {py[i].get(k)!r}')
                    if px[i].get('polygon') != py[i].get('polygon'): add(n, f'부분 {i}: 외곽 좌표가 다르다')
    for k in ('about', 'generated'):
        if expected.get(k) != actual.get(k): add('(파일 머리)', f'{k} 가 다르다')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('mode', choices=('check', 'write'))
    ap.add_argument('--notes', default=DEFAULT_NOTES)
    ap.add_argument('--overrides', default=str(DEFAULT_OVERRIDES))
    a = ap.parse_args(argv)
    if not pathlib.Path(a.notes).is_dir():
        print(f'동 노트 폴더가 없다: {a.notes}'); return 2
    doc, problems = build(a.notes)
    for n, bad in problems.items():
        for b in bad: print(f'[노트 문제] {n}: {b}')
    path = pathlib.Path(a.overrides)
    if a.mode == 'write':
        if problems:
            print('노트에 문제가 있어 쓰지 않았다.'); return 1
        path.write_text(dumps(doc), encoding='utf-8', newline='\n')
        print(f"썼다: {path} (지붕 {len(doc['buildings'])}, 숨김 {len(doc['hidden'])}, 부분 나누기 {len(doc['parts'])}, 건물 추가 {len(doc['added'])})")
        return 0
    text = path.read_text(encoding='utf-8')
    d = diff(doc, json.loads(text))
    for n, msgs in sorted(d.items()):
        for m in msgs: print(f'[불일치] {n}: {m}')
    same_text = text == dumps(doc)
    if not d and not same_text and not problems: print('[불일치] 값은 같지만 파일 글자가 생성 결과와 다르다(손으로 고친 흔적). write 로 다시 만든다.')
    names = lambda sec: ', '.join(f"{e['name']}" + (f"({len(e['parts'])})" if sec == 'parts' else '') for e in doc[sec]) or '없음'
    print(f"노트 기준: 지붕 {names('buildings')} / 숨김 {names('hidden')} / 부분 나누기 {names('parts')} / 건물 추가 {names('added')}")
    ok = not problems and not d and same_text
    print('일치' if ok else '불일치: 노트가 맞다. 노트를 고친 뒤 write, 다시 check.')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
