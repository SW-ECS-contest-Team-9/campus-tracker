#!/bin/sh
# P02: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/p02/apply.sh <번호 머리말>
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# 순서: 시험용 체크아웃에 합침 -> 길 상태(전) -> scene:import(겉모습) -> 길 상태(후) -> 전후 비교. 지형·길 쓰기 없음.
set -e
TAG=${1:-a}
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/p02"; mkdir -p "$V"
cd /c/campus-tracker-testdb
rm -f frontend/public/structures/p02-parts.geojson; git checkout -- frontend/public/structures/p01-parts.geojson   # 작업 중 미리 보려고 베껴 둔 것(합치면 같은 파일이 들어온다)
git merge --no-edit claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/u04/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
npm run scene:import -- --dir=data/scene/source > "$V/$TAG-22-scene-import.txt" 2>&1 || { tail -8 "$V/$TAG-22-scene-import.txt"; exit 1; }
tail -1 "$V/$TAG-22-scene-import.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/u04/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
