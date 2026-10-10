#!/bin/sh
# Z05: 시험용 DB(127.0.0.1:5544)에 새 지형·건물을 적용한다. 운영 서버에는 접속하지 않는다.   sh apply.sh <직전 지형 id> <번호 머리말>
# 먼저 claude/modeling-audit 를 시험용 체크아웃에 합쳐 둔다. 출력 원문은 볼트 z05 폴더에 남긴다.
set -e
PREV=$1; TAG=$2
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/z05"
cd /c/campus-tracker-testdb
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
npx tsx scripts/terrain-recipe.ts seoul5000-2015-ba7fcb19 data/terrain/recipes/z05-smooth-ground.json --save > "$V/$TAG-12-recipe-save.txt" 2>&1
ID=$(grep -m1 '"id"' "$V/$TAG-12-recipe-save.txt" | sed 's/.*"\(recipe-[0-9a-f]*\)".*/\1/'); echo "terrain $ID"
if [ "$ID" != "$PREV" ]; then
  npx tsx scripts/terrain-versions.ts activate $ID > "$V/$TAG-14-activate.txt" 2>&1; head -1 "$V/$TAG-14-activate.txt"
  npx tsx scripts/terrain-versions.ts relevel-roads $PREV $ID --save --as=T05 > "$V/$TAG-15-relevel-save.txt" 2>&1 || true; grep -m2 'saved\|changeSetId\|rror' "$V/$TAG-15-relevel-save.txt"
fi
npm run scene:import -- --dir=data/scene/source > "$V/$TAG-22-scene-import.txt" 2>&1; tail -1 "$V/$TAG-22-scene-import.txt"
