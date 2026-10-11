"""U07: 층 사이 경사로를 학교 지하도 지도의 굽은 부채꼴 띠 자리로(시험용 DB 변경 묶음). DB·네트워크 접근 없음.   python build.py
먼저: python crescent.py (지도의 부채꼴 → crescent.json), python ../u02/build_parts.py, python ../u04/build.py, 다시 ../u02/build_parts.py·../u04/build.py (기둥은 주차 칸을 읽는다), python ../u04/pairs.py.
쓰는 파일: groups/u07.json (적용은 apply.sh, 시험용 DB 에만).
근거: 사용자 2026-10-12 "이거(학교 지하도 지도) 보면 이해될 텐데", 사용자 표시 3(사진 13·14·15), 사진 03·04·11. 볼트 구역 노트 "운동장 아래 지하층과 지하 차도"(U07 절)."""
import json, pathlib
HERE = pathlib.Path(__file__).parent
M = json.loads((HERE.parent / 'u02' / 'model.json').read_text(encoding='utf-8')); RP = M['ramp']; CR = json.loads((HERE / 'crescent.json').read_text(encoding='utf-8'))
OLD = '8cf87ad5-2394-4ef2-8aa2-d0fed677cb66'   # U06 의 층 사이 경사로(개정 1)
EV = (f"사용자 2026-10-12: 학교 지하도 지도를 다시 보내며 경사로 자리는 지도로 알 수 있다고 함. 지도의 주차장 서쪽, 은주1관 초록 점 남동쪽에 굽은 부채꼴 띠가 그려져 있다. 블로그-03 에서 외곽을 읽어 좌표로 옮김: "
      f"중심 ({CR['centre'][0]}, {CR['centre'][1]}), 바깥 반지름 {CR['outerRadiusM']} m, 안쪽 {CR['innerRadiusM']} m, 방위 {CR['bearingSouthEndDeg']}~{CR['bearingNorthEndDeg']}도(가운데 선 {CR['centreLineLengthM']} m). "
      f"좌표 맞춤 잔차 RMS {CR['residual']['georefRmsM']} m, 원 맞춤 {CR['residual']['outerCircleFitRmsM']} m. U06 의 '문 앞 바닥 밑으로 북쪽으로 내려가 북서 모서리 밑에서 되돈다'는 지도에 없는 추정이라 버림")
ops = [{'ref': '거둠: U06 층 사이 경사로', 'op': 'retire_feature', 'args': {'type': 'road', 'id': OLD, 'expectedRevision': 1}, 'grade': '원천(학교 지도), 사용자 지적', 'evidence': EV},
       {'ref': '층 사이 경사로(지도의 부채꼴)', 'op': 'create_road', 'grade': '원천(평면: 학교 지도의 부채꼴, 잔차 RMS 3.3 m), 확정(낮은 벽이 은주관 문 쪽: 사용자 표시 3), 추정(내려가는 방향·경사·바닥 아래 구간·발치)',
        'evidence': EV + (f". 부채꼴의 남쪽 끝이 어귀(지하 1층 바닥), 섬을 오른쪽에 끼고 시계 방향으로 내려가 북쪽 끝의 낮은 벽 밑({RP['belowFloorAtBandM']} m 아래)으로 든다(사진 11, 추정). 그 뒤 같은 원을 {RP['turnDeg']}도까지 돌고"
                          f" 주차 줄 방향으로 곧은 구간 {RP['straightM']} m(사진 04, 추정). 높이 차 {RP['dropM']} m 는 줄이지 않았다"),
        'args': {'roadClass': 'vehicle', 'name': f"운동장 지하 1층–지하 2층 경사로 (학교 지도의 굽은 부채꼴: 남쪽 끝 어귀 ~ 섬을 끼고 돌아 ~ 북쪽 끝 낮은 벽 밑 ~ 같은 원으로 더 돌아 ~ 곧은 구간 ~ 지하 2층. {RP['lengthM']} m 에 {RP['dropM']} m, 경사 {RP['gradePct']} %. 부채꼴 자리는 학교 지도, 방향과 바닥 아래 구간은 추정)",
                 'structure': 'ramp', 'widthM': RP['straightWidthM'], 'vehicleAccess': 'allowed', 'pedestrianAccess': 'prohibited', 'vehicleDirection': 'both', 'pedestrianDirection': 'unknown', 'path': RP['path'], 'zMode': 'explicit', 'densify': False}}]
(HERE / 'groups').mkdir(exist_ok=True)
(HERE / 'groups' / 'u07.json').write_text(json.dumps({'id': 'U07', 'zone': '운동장 아래 지하층과 지하 차도', 'comment': 'U07: U06 의 층 사이 경사로를 거두고 학교 지하도 지도의 굽은 부채꼴 자리의 경사로로', 'ops': ops}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
print(len(ops), 'ops', len(RP['path']), 'points')
