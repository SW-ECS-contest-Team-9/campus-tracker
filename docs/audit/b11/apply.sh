#!/bin/sh
# B11: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다. 볼트 목표.md 진행 기록에 "Z06 완료"가 생긴 뒤에 실행한다.
#   sh docs/audit/b11/apply.sh        (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# 순서: 시험용 체크아웃에 합침 -> 건물 id 바로잡기 -> scene:import -> 혜인관 길·장소 건물 표기 -> 상태·도달 쌍 비교. 출력 원문은 볼트 b11 폴더.
set -e
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/b11"; mkdir -p "$V"
grep -q "Z06 완료" "/c/campus-tracker-backend/데이터/모델링 개선/목표.md" || { echo "아직 Z06 완료가 없다. 멈춤."; exit 1; }
cd /c/campus-tracker-testdb
git merge --no-edit claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts; B11=../docs/audit/b11
npx tsx $N02 state "$V/01-state-before.json" ../docs/audit/n03/pairs.json > "$V/01-state-before.txt" 2>&1
npx tsx scripts/building-ids-rename.ts --dry-run > "$V/10-building-ids-dry.txt" 2>&1
npx tsx scripts/building-ids-rename.ts > "$V/11-building-ids.txt" 2>&1; tail -3 "$V/11-building-ids.txt"
npm run scene:import -- --dir=data/scene/source --dry-run > "$V/21-scene-dry-run.txt" 2>&1
npm run scene:import -- --dir=data/scene/source > "$V/22-scene-import.txt" 2>&1; tail -1 "$V/22-scene-import.txt"
python $B11/build_groups.py "$V/01-state-before.json" > "$V/30-groups.txt"
npx tsx $N02 apply $B11/groups/hyein-id.json "$V/31-hyein-id-dry.json" > "$V/31-hyein-id-dry.txt" 2>&1
npx tsx $N02 apply $B11/groups/hyein-id.json "$V/32-hyein-id.json" --commit > "$V/32-hyein-id.txt" 2>&1; tail -2 "$V/32-hyein-id.txt"
npx tsx scripts/building-ids-rename.ts --dry-run > "$V/33-building-ids-after.txt" 2>&1; tail -2 "$V/33-building-ids-after.txt"
npx tsx $N02 state "$V/40-state-after.json" ../docs/audit/n03/pairs.json > "$V/40-state-after.txt" 2>&1
python $B11/compare_state.py "$V/01-state-before.json" "$V/40-state-after.json"
