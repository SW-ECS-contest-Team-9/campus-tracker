#!/bin/sh
# W01: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/w01/apply.sh <번호 머리말> [commit]
#   (C:\campus-tracker-claude 에서. 시험용 백엔드 3210 이 떠 있어야 한다)
# commit 없이: 시험용 체크아웃에 합침(빨리 감기만) -> 길 상태(전) -> 길 변경 묶음 미리 보기(저장 안 함).
# commit: 묶음을 지금 DB 로 다시 만들어 저장 -> 길 상태(후) -> 전후 비교. 지형·건물 장면 쓰기 없음(구조물 파일과 길 묶음뿐).
set -e
TAG=${1:-a}; MODE=$2
HERE=/c/campus-tracker-claude/docs/audit/w01
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/w01"; mkdir -p "$V"
cd /c/campus-tracker-testdb
git merge --ff-only claude/modeling-audit
cd backend
grep -q "127.0.0.1:5544" ../.env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
N02=../docs/audit/n02/n02.ts
if [ "$MODE" != "commit" ]; then
  npx tsx $N02 state "$V/$TAG-01-state-before.json" ../docs/audit/u04/pairs.json > "$V/$TAG-01-state-before.txt" 2>&1
  (cd $HERE && python -X utf8 build_group.py "$V/$TAG-01-state-before.json")
  npx tsx $N02 apply $HERE/groups/w01.json "$V/$TAG-04-roads-dry.json" > "$V/$TAG-04-roads-dry.txt" 2>&1 || { tail -5 "$V/$TAG-04-roads-dry.txt"; exit 1; }
  tail -3 "$V/$TAG-04-roads-dry.txt"; exit 0
fi
npx tsx $N02 state "$V/$TAG-02-state-now.json" ../docs/audit/u04/pairs.json > "$V/$TAG-02-state-now.txt" 2>&1
(cd $HERE && python -X utf8 build_group.py "$V/$TAG-02-state-now.json")
npx tsx $N02 apply $HERE/groups/w01.json "$V/$TAG-05-roads.json" --commit > "$V/$TAG-05-roads.txt" 2>&1 || { tail -5 "$V/$TAG-05-roads.txt"; exit 1; }
tail -1 "$V/$TAG-05-roads.txt"
npx tsx $N02 state "$V/$TAG-40-state-after.json" ../docs/audit/u04/pairs.json > "$V/$TAG-40-state-after.txt" 2>&1
python ../docs/audit/b11/compare_state.py "$V/$TAG-01-state-before.json" "$V/$TAG-40-state-after.json"
