#!/bin/sh
# Z07: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/z07/apply.sh <번호 머리말>
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# 순서: 시험용 체크아웃에 합침 -> 길 상태(전) -> 지형 조리법 미리보기만(저장·전환 없음: Z07 은 기단을 안 바꿨다. B11 의 건물 id 정정 뒤로 건물 입력 해시가 달라 미리보기 id 는 활성 지형과 다르게 나온다) -> scene:import -> 길 상태(후) -> 전후 비교. 출력 원문은 볼트 z07 폴더.
set -e
TAG=${1:-a}
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/z07"; mkdir -p "$V"
cd /c/campus-tracker-testdb
git merge --no-edit claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/n03/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
npx tsx scripts/terrain-recipe.ts seoul5000-2015-ba7fcb19 data/terrain/recipes/z05-smooth-ground.json > "$V/$TAG-11-recipe-preview.txt" 2>&1
grep -m1 '"id"' "$V/$TAG-11-recipe-preview.txt" || true
npm run scene:import -- --dir=data/scene/source > "$V/$TAG-22-scene-import.txt" 2>&1; tail -1 "$V/$TAG-22-scene-import.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/n03/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
