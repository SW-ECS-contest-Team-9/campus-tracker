# 지형 축척·재현 검증

EPSG:5186의 단위는 m이며 캠퍼스 원점 이동은 축척을 바꾸지 않는다. 화면 원근 축척은 고정되지 않는다. 원자료 1:5,000 제작 축척과 출력 2m 격자 간격은 실측 정확도가 아니다.

서버의 backend 폴더에서 `npx tsx scripts/terrain-audit.ts`를 실행한다. 기존 환경 설정으로 DB에 연결하고 READ ONLY 트랜잭션에서 원자료를 운영과 같은 PostGIS 변환으로 처리한다. 지형·건물·경로·활성 버전을 수정하지 않는다.

출력은 활성 DEM과 재생성 DEM의 셀별 차이, 유효 표고점 수, 표고점 제외 교차검증 잔차다. 셀 차이가 있으면 원자료·알고리즘·변환 환경이 다를 수 있으므로 `terrain:import`로 덮어쓰지 말고 원인을 확인한다. leave-one-out 수치도 현장 측량에 의한 독립 검증은 아니다.

2026-10-09 로컬 재현: seoul5000-2015-ba7fcb19의 208,800셀 전부 일치. 유효 표고점 39개. 수정된 교차검증 절대잔차 90% 약 4.88m. 다른 명시적 Helmert 변환은 4.6cm 수준의 좌표 차이가 격자화에서 증폭되어 일부 셀에 큰 차이를 만들었다.

운동장 평탄화는 측량된 영역·출입구·옹벽 경계가 필요하다. 141.73m는 사용자가 정한 모델 기준이며 측량 확인값으로 표기하지 않는다. 건물은 외곽선 돌출 모형으로 실제 층 바닥·출입구와 분리해서 검토한다. 실내·지하·육교를 단일 DEM에 합치지 않는다.

추가 자료 후보: [서울시 수치지형도 안내](https://news.seoul.go.kr/gov/archives/528208), [국토정보플랫폼](https://map.ngii.go.kr), [QGIS 기준점 정합](https://doc.qgis.org/3.44/en/docs/user_manual/managing_data_source/georeferencer.html), [IFC 지도 좌표 연결](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcMapConversion.htm). 캠퍼스의 최신 도엽과 준공도면은 아직 확보하지 않았다.
