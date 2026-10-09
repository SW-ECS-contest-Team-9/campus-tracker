# 평탄부 지형 후보

운영 지형에서 지정 영역만 평탄화하는 별도 후보를 만든다. 건물, 경로, 활성 버전을 변경하지 않는다.

backend에서 실행:

```sh
npx tsx scripts/terrain-plateau.ts BASE_VERSION polygon.geojson
npx tsx scripts/terrain-plateau.ts BASE_VERSION polygon.geojson --save
```

첫 명령은 읽기 전용 미리보기다. `--save`는 비활성 DRAFT 버전만 추가한다. 같은 입력은 같은 ID를 사용하며 기존 버전을 덮어쓰지 않는다. 활성화는 지원하지 않는다.

입력은 EPSG:5186 미터 좌표의 GeoJSON Feature이다. geometry는 유효한 Polygon이며 properties에 `srid: 5186`, `heightM: 141.73`, 보정 근거를 설명하는 `reason`이 필요하다. 모든 영역이 원본 격자 안에 있어야 한다. 좌표계는 입력 작성자가 확인해야 하며 파일 숫자만으로 식별할 수 없다.

셀 중심이 폴리곤 내부인 곳의 높이를 바꾼다. 외부 전이 경사를 임의 생성하지 않는다. 경계에서 쌍선형 보간은 외부 셀의 영향을 받는다. 원본 sigma는 유지하지만 새 표면의 현장 정확도가 검증됐다는 의미는 아니다. 새 메타데이터에 이 제한과 원본 버전, 변경량, 입력을 기록한다.

운영 반영 전 실제 평탄부 경계, 후면 산지, 계단/램프 접속, 건물 기초와 실내 바닥을 확인해야 한다. 원본 DEM의 QA를 보정 후보 QA로 재사용하지 않는다.
