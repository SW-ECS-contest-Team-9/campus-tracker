# B11 건물: 층 높이 모순, 사진과 다른 형상, 혜인관 건물 id

기록은 볼트 동 노트(본관·한림관·청운관·대일관·문예관·유담관·혜인관)의 "B11" 절과 건물 규칙서 "B11 갱신". 여기는 계산과 적용 도구만 둔다.

| 파일 | 하는 일 |
|---|---|
| `mesh.py` | 볼트의 S-MAP 메시 판독 파일 읽기 |
| `b11.py` → `results.json` | 본관–한림관 틈의 지면(평탄면 없음), 층 사다리(본관·청운관·문예관), 문예관 저층부 외곽, 유담관 탑 띠 6개. DB 없음 |
| `write_notes.py` | 동 노트 머리 고치기 + B11 절 덧붙이기(한 번만) |
| `build_groups.py STATE.json` → `groups/` | 시험용 DB 변경 묶음: `hyein-id`(길 8·장소 2의 건물 표기), `deck`(준비만, 적용 안 함) |
| `apply.sh` | 시험용 DB 적용 순서(Z06 완료 뒤): 건물 id 바로잡기 → `scene:import` → 혜인관 건물 표기 → 전후 비교 |
| `compare_state.py` | 길 검사·도달 쌍 66개 전후 비교 → `state-compare.json` |
| `views.json` | 고친 건물을 사진과 같은 시점에서 갈무리할 때의 시점(`node ../z05/shots.mjs views.json <볼트 b11> 지도`) |

건물 id 정정(H02)은 `backend/data/campus-map/overrides/building-ids.json`, `backend/src/modules/spatial/building-ids.ts`, `backend/scripts/building-ids-rename.ts`.
운영 서버에서는: push·배포 뒤 `npx tsx scripts/building-ids-rename.ts` → `npm run scene:import -- --dir=data/scene/source` → 편집기에서 혜인관 길 8개·장소 2곳의 건물 표기를 `혜인관`으로(사용자 승인 뒤).
