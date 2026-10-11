#!/bin/sh
# U05: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   GROUP=u05.json AREAS=1 sh docs/audit/u05/apply.sh <번호 머리말>
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다. 시험용 체크아웃에 미리 합친다. scene:import 는 돌리지 않는다)
# 순서: 길 상태(전, 쌍은 U04 것. 이미 있으면 다시 찍지 않는다) -> 길 묶음(한 번만) -> 통로 면 둘(u04/areas: 같은 이름이면 고친다) -> 길 상태(후) -> 전후 비교 -> 지하도 경로 길이 -> 구획 파일은 따로(python docs/audit/f08/build_zones.py)
set -e
TAG=${1:-a}
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/u05"; mkdir -p "$V"
cd /c/campus-tracker-testdb/backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
[ -f "$V/$TAG-01-state-before.json" ] || npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/u04/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
if [ -n "$GROUP" ]; then npx tsx $N02 apply "../docs/audit/u05/groups/$GROUP" "$V/$TAG-05-roads-$GROUP" --commit > "$V/$TAG-05-roads.txt" 2>&1; tail -1 "$V/$TAG-05-roads.txt"; fi
if [ -n "$AREAS" ]; then python ../docs/audit/u04/areas_put.py "$V/$TAG-06-area"; fi
npx tsx $N02 rest GET areas > "$V/$TAG-39-areas-after.json" 2>&1
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/u04/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
python ../docs/audit/u04/route.py "$V/$TAG-41-routes.json"
