#!/bin/sh
# Z11: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/z11/apply.sh <직전 지형 id> <번호 머리말>
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# 순서: 시험용 체크아웃에 합침 -> 길 상태(전) -> 지형 조리법 저장 -> (id 가 다르면) 전환·길 다시 맞추기 -> scene:import -> 길 상태(후) -> 전후 비교. 출력 원문은 볼트 z11 폴더.
set -e
PREV=$1; TAG=${2:-a}
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/z11"; mkdir -p "$V"
cd /c/campus-tracker-testdb
git merge --no-edit claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/n03/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
# 길 변경 묶음(있을 때만, 한 번만): GROUP=<묶음 파일> 로 준다
if [ -n "$GROUP" ]; then npx tsx $N02 apply "$GROUP" "$V/$TAG-05-roads-$(basename "$GROUP")" --commit > "$V/$TAG-05-roads.txt" 2>&1; tail -1 "$V/$TAG-05-roads.txt"; fi
npx tsx scripts/terrain-recipe.ts seoul5000-2015-ba7fcb19 data/terrain/recipes/z05-smooth-ground.json --save > "$V/$TAG-12-recipe-save.txt" 2>&1
ID=$(grep -m1 '"id"' "$V/$TAG-12-recipe-save.txt" | sed 's/.*"\(recipe-[0-9a-f]*\)".*/\1/'); echo "terrain $ID"
if [ "$ID" != "$PREV" ]; then
  npx tsx scripts/terrain-versions.ts activate $ID > "$V/$TAG-14-activate.txt" 2>&1; head -1 "$V/$TAG-14-activate.txt"
  npx tsx scripts/terrain-versions.ts relevel-roads $PREV $ID --save --as=T05 > "$V/$TAG-15-relevel-save.txt" 2>&1 || true; grep -m2 'saved\|changeSetId\|rror' "$V/$TAG-15-relevel-save.txt" || true
fi
npm run scene:import -- --dir=data/scene/source > "$V/$TAG-22-scene-import.txt" 2>&1; tail -1 "$V/$TAG-22-scene-import.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/n03/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
