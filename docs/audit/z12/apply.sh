#!/bin/sh
# Z12: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/z12/apply.sh <번호 머리말> [commit]
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# commit 없이: 시험용 체크아웃에 합침(빨리 감기만) -> 길 상태(전) -> 묶음 1 미리 보기(저장 안 함).
# commit: 묶음 1 저장 -> 묶음 2 를 지금 DB 로 만들어 미리 보기 -> 저장 -> 길 상태(후) -> 전후 비교. 지형·건물 장면 쓰기 없음(구조물 파일만 바뀜).
set -e
TAG=${1:-a}; MODE=$2
HERE=/c/campus-tracker-claude/docs/audit/z12
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/z12"; mkdir -p "$V"
cd /c/campus-tracker-testdb
git merge --ff-only claude/modeling-audit
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
if [ "$MODE" != "commit" ]; then
  npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/u04/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
  (cd $HERE && python -X utf8 build_group.py 1)
  npx tsx $N02 apply $HERE/groups/z12-1.json "$V/$TAG-04-roads-1-dry.json" > "$V/$TAG-04-roads-1-dry.txt" 2>&1 || { tail -5 "$V/$TAG-04-roads-1-dry.txt"; exit 1; }
  tail -2 "$V/$TAG-04-roads-1-dry.txt"; exit 0
fi
npx tsx $N02 apply $HERE/groups/z12-1.json "$V/$TAG-05-roads-1.json" --commit > "$V/$TAG-05-roads-1.txt" 2>&1 || { tail -5 "$V/$TAG-05-roads-1.txt"; exit 1; }
tail -1 "$V/$TAG-05-roads-1.txt"
(cd $HERE && python -X utf8 build_group.py 2)
npx tsx $N02 apply $HERE/groups/z12-2.json "$V/$TAG-06-roads-2-dry.json" > "$V/$TAG-06-roads-2-dry.txt" 2>&1 || { tail -5 "$V/$TAG-06-roads-2-dry.txt"; exit 1; }
npx tsx $N02 apply $HERE/groups/z12-2.json "$V/$TAG-07-roads-2.json" --commit > "$V/$TAG-07-roads-2.txt" 2>&1 || { tail -5 "$V/$TAG-07-roads-2.txt"; exit 1; }
tail -1 "$V/$TAG-07-roads-2.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/u04/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
