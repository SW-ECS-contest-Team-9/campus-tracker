#!/bin/sh
# R01: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/r01/apply.sh <직전 지형 id> <번호 머리말> [save]
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# 첫 실행(save 없음): 시험용 체크아웃에 합침 -> 길 상태(전) -> 조리법 미리 보기(저장 안 함)와 바뀐 칸 견줌(두 작업 구역 밖·건물 칸·끝난 구역이 하나라도 있으면 멈춤)
#   -> 조리법 저장 -> 전환 -> 길 다시 맞추기 미리 보기(저장 안 함).
# save: 길 다시 맞추기 저장 -> scene:import -> 길 상태(후) -> 전후 비교. 출력 원문은 볼트 r01 폴더.
set -e
PREV=$1; TAG=${2:-a}; MODE=$3
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/r01"; mkdir -p "$V"
cd /c/campus-tracker-testdb
git merge --ff-only claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts; RECIPE=data/terrain/recipes/z05-smooth-ground.json; BASE=seoul5000-2015-ba7fcb19
if [ "$MODE" != "save" ]; then
  npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/u04/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
  npx tsx ../docs/audit/r01/preview.ts $BASE $RECIPE "$V/$TAG-10-preview.f32" > "$V/$TAG-10-preview.txt" 2>&1; cat "$V/$TAG-10-preview.txt"
  python -X utf8 ../docs/audit/r01/check_cells.py "$V/01-terrain-$PREV.f32" "$V/$TAG-10-preview.f32" "$V/$TAG-11-changed-cells.csv" > "$V/$TAG-11-changed-cells.txt" 2>&1 || { cat "$V/$TAG-11-changed-cells.txt"; echo "바뀐 칸이 작업 구역 밖에 있다. 저장하지 않고 멈춤."; exit 1; }
  cat "$V/$TAG-11-changed-cells.txt"
  npx tsx scripts/terrain-recipe.ts $BASE $RECIPE --save > "$V/$TAG-12-recipe-save.txt" 2>&1
  ID=$(grep -m1 '"id"' "$V/$TAG-12-recipe-save.txt" | sed 's/.*"\(recipe-[0-9a-f]*\)".*/\1/'); echo "terrain $ID"
  npx tsx scripts/terrain-versions.ts activate $ID > "$V/$TAG-14-activate.txt" 2>&1; head -3 "$V/$TAG-14-activate.txt"
  npx tsx scripts/terrain-versions.ts relevel-roads $PREV $ID > "$V/$TAG-15-relevel-preview.txt" 2>&1 || true; echo "길 다시 맞추기 미리 보기: $V/$TAG-15-relevel-preview.txt"
  exit 0
fi
ID=$(grep -m1 '"id"' "$V/$TAG-12-recipe-save.txt" | sed 's/.*"\(recipe-[0-9a-f]*\)".*/\1/')
npx tsx scripts/terrain-versions.ts relevel-roads $PREV $ID --save --as=T05 > "$V/$TAG-16-relevel-save.txt" 2>&1 || true; grep -m2 'saved\|changeSetId\|rror' "$V/$TAG-16-relevel-save.txt" || true
npm run scene:import -- --dir=data/scene/source > "$V/$TAG-22-scene-import.txt" 2>&1; tail -1 "$V/$TAG-22-scene-import.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/u04/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
