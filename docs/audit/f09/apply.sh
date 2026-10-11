#!/bin/sh
# F09: 시험용 DB(127.0.0.1:5544)에만 적용한다. 운영 서버에는 접속하지 않는다.   sh docs/audit/f09/apply.sh
#   (C:\campus-tracker-claude 에서. 커밋한 뒤에 돌린다)
# 순서: 시험용 체크아웃에 합침 -> 장면 전 상태 저장 -> scene:import(겉모습에 층 이름만 더해짐) -> 건물 바닥·지붕·외곽 전후 비교.
# 길·지형 쓰기 없음. 백엔드(3210)는 합친 뒤 다시 띄워야 새 읽기 전용 주소(승강기·장소)가 나온다.
set -e
V="/c/campus-tracker-backend/데이터/보완자료/3d-map-audit-20261009/f09"; mkdir -p "$V"
cd /c/campus-tracker-testdb
grep -q "127.0.0.1:5544" .env || { echo "시험용 DB 가 아니다. 멈춤."; exit 1; }
curl -s http://127.0.0.1:3210/api/v1/scene > "$V/a-01-scene-before.json"
git merge --no-edit claude/modeling-audit
git ls-files -z backend/data | xargs -0 rm -f && git -c core.autocrlf=false checkout -- backend/data
python docs/audit/registry/building_registry.py check | tail -1
cd backend
npm run scene:import -- --dir=data/scene/source > "$V/a-22-scene-import.txt" 2>&1; tail -1 "$V/a-22-scene-import.txt"
curl -s http://127.0.0.1:3210/api/v1/scene > "$V/a-40-scene-after.json"
python ../docs/audit/f09/compare_scene.py "$V/a-01-scene-before.json" "$V/a-40-scene-after.json" | tee "$V/a-41-scene-compare.txt"
