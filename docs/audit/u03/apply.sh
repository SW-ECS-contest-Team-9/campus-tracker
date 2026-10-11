#!/bin/sh
# U03: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/u03/apply.sh <번호 머리말>
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# 순서: 시험용 체크아웃에 합침 -> 길 상태(전) -> 길 묶음(GROUP=u03.json), 장소 묶음(PLACES=u03p.json): 한 번만 -> scene:import(동 노트 층 표가 바뀌어 건물 보정 파일이 바뀜) -> 길 상태(후, 쌍 73) -> 전후 비교 -> 지하도 경로 길이. 지형 입력은 그대로.
set -e
TAG=${1:-a}
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/u03"; mkdir -p "$V"
cd /c/campus-tracker-testdb
git merge --no-edit claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/n03/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
if [ -n "$GROUP" ]; then npx tsx $N02 apply "$GROUP" "$V/$TAG-05-roads-$(basename "$GROUP")" --commit > "$V/$TAG-05-roads.txt" 2>&1; tail -1 "$V/$TAG-05-roads.txt"; fi
if [ -n "$PLACES" ]; then npx tsx $N02 apply "$PLACES" "$V/$TAG-06-places-$(basename "$PLACES")" --commit > "$V/$TAG-06-places.txt" 2>&1; tail -1 "$V/$TAG-06-places.txt"; fi
npm run scene:import -- --dir=data/scene/source > "$V/$TAG-22-scene-import.txt" 2>&1; tail -1 "$V/$TAG-22-scene-import.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/u03/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
python ../docs/audit/u03/route.py "$V/$TAG-40-state-after.json" "$V/$TAG-41-routes.json"
