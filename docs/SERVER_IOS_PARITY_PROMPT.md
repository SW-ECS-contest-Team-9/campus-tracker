# 서버 전달용: iOS/Android 비교 조건 통일과 융합 진단 개선

아래 프롬프트는 iOS 작업과 별도로 서버 담당 에이전트에 전달한다. iOS 작업 프롬프트는 `docs/IOS_ANDROID_BASELINE_XCODE_PROMPT.md`다.

---

CampusTracker-Server의 iOS 위치 추적 문제를 조사하고 서버/프리뷰를 개선하라. 먼저 코드와 실제 데이터로 원인을 검증하고, 필요한 최소 변경을 구현·테스트하라. Android를 회귀 기준으로 삼되 Android 좌표를 ground truth로 사용하지 말라. 기존 작업 및 ARKit 변경을 보존한다. 모바일 앱은 이 작업에서 수정하지 않는다. 운영 세션을 임의로 종료하거나 운영 fused 결과를 실험 결과로 덮어쓰지 않는다.

## 1. 고정 사례와 확인된 사실

2026-10-13 22시대 KST의 읽기 스냅샷이며 이후 변경 가능성이 있다.

- 프리뷰 http://100.93.21.92:5173/, API http://100.93.21.92:3000/api/v1/.
- C04 iOS `7fc9fe96-61d7-4373-bf08-fb3f95f1f6dc`: 21:54:31 시작, 마지막 센서 22:06:02, ACTIVE/OFFLINE. finishRequestedAt 및 syncManifest 없음.
- C02 Android `ec40aab5-749f-43b5-8b17-3ce68ad62672`: 21:54:52 시작, 22:16:08 종료, FINISHED/FINALIZED.
- 둘 다 motionUpdateHz=50, trueNorth, fullAccuracy. C04 motion 33,669개/744걸음/학습 보폭 0.65m. Android 보폭 0.72m는 DEFAULT이다.
- C04 배치 681개 중 역순 263개, motion gap 21.610초 1회/센서 구간 2개. Android 역순 0개, 최대 motion 간격 23ms/구간 1개.
- 겹치는 시간의 GPS 보고 정확도 중앙값 C04 14.25m / C02 6.28m, 수신 지연 중앙값 4.90초 / 1.78초, p90 205.78초 / 2.20초. 동일 경로는 미확인이다.
- C04 22:13 api 재처리: COMPLETED/CLEAN이지만 ACTIVE이므로 finalize=false. 672개 출력, 처음 약 172초 heading UNKNOWN, 전체 177개 출력의 heading 없음. 전체 ellipsoidalAltitude=null, zDatumSource=NONE. 상대 고도 범위 약 50.3m.
- C02 종료 후 auto-finalize: RTS 평활화·방향 재추정 완료, 전체 출력에 절대 고도/TERRAIN 기준 존재. 처리 단계가 다르므로 두 궤적을 그대로 비교하면 안 된다.
- C04는 이후 시간순 전방 재처리가 완료된 상태다. 현재 저장 결과의 모든 오차를 역순 업로드로 설명하지 말라. Stop 여부와 21.6초 공백의 원인은 아직 미확인이다.

## 2. 먼저 읽을 코드와 재현 자료

- `backend/src/modules/fusion/fusion.service.ts`: reprocessNow, continuesLive, processBatch, finalizeSoon.
- `fusion.algorithms.ts`, `fusion-v4.engine.ts`, `fusion-v4.smoother.ts`, `fusion-state-v4.ts`, `fusion.config.ts`, timeline/reorder/replay 구현을 찾아 읽기.
- `backend/src/modules/sessions/session.service.ts`, session DTO/repository: collection/connection/sync 상태, finish/syncComplete 및 late upload 정책.
- `backend/src/modules/telemetry/telemetry.service.ts`, telemetry DTO/repository: commit/ACK, sample dedup, 역순 감지.
- `backend/src/modules/fusion/fusion-runs.repository.ts`와 Lab replay API/서비스: publish=false, SENSOR_TIME/AS_RECEIVED, snapshot 보존 방식.
- `frontend/src/main.ts`, `frontend/src/api.ts`, `frontend/src/trajectory.ts` 및 Lab UI.
- Android `sync/TelemetrySyncCoordinator.kt`, iOS `Services/CollectionCoordinator.swift`는 입력 계약 비교용으로 읽는다.

위 두 세션의 원시 데이터·진단 이벤트·배치 도착 메타데이터·기존 run 설정/revision/terrain/map 버전을 읽기 전용으로 확보하라. 필요한 API가 없으면 승인된 DB 읽기 경로를 사용하라. 연결이 안 되면 fixture 테스트를 계속하고 실제 재현은 미완료로 명시하라. 현재 코드를 실행한 결과와 당시 배포 코드의 결과를 같은 것으로 취급하지 말라.

## 3. P0: ACTIVE 상태에서도 전방/최종 결과를 공정하게 비교

현재 ACTIVE인 live 버전의 publish 재처리는 실시간 상태를 이어받기 위해 finalize=false인 것이 의도된 동작이다. 이 조건을 단순 제거하면 미래 데이터를 사용한 평활화 상태가 실시간 엔진을 오염시킬 수 있다.

1. 기존 Lab의 비공개 실험 run(`publish=false`)을 우선 재사용해 C04의 SENSOR_TIME 전방 결과와 같은 cutoff의 finalized 결과를 따로 만든다. finalize 실행 여부가 명시적이지 않으면 최소한의 선택 필드/실행 메타데이터를 추가한다. 이미 가능한 기능은 중복 구현하지 않는다.
2. snapshot의 cutoff, 입력 건수/해시, 알고리즘 revision/config hash, 지형/지도 버전, 입력 정렬 방식, 실제 finalize 적용 여부를 기록한다. 동시 업로드가 있더라도 한 run 내부 입력 경계는 일관되어야 한다.
3. 실험은 collection status, live state, 운영 fused_positions, CLEAN/DIRTY 표시를 바꾸지 않는다. 프리뷰/Lab에서 ‘실시간/시간순 전방/최종 평활화’를 명확히 구분해 선택할 수 있게 한다.
4. C02도 같은 시간 cutoff와 같은 처리 모드로 비교한다. 전체 21분 Android와 11분 iOS의 걸음 수/경로 길이를 그대로 비율 비교하지 않는다.
5. AS_RECEIVED와 SENSOR_TIME 전방의 차이로 지연·역순 영향, SENSOR_TIME 전방과 FINAL 차이로 평활화 효과를 분리한다. 실제 경로 기준점 없이 오차가 몇 m 줄었다고 주장하지 않는다.

## 4. P0: 종료 상태와 동기화 상태의 의미 유지

- offline/disconnect/무수신 시간만으로 ACTIVE를 FINISHED로 바꾸지 않는다. 오프라인 수집과 뒤늦은 업로드가 정상 기능이다.
- 프리뷰에 ‘ACTIVE·최근 수신 없음’, ‘종료 요청 수신 여부’, ‘manifest 비교 결과’, ‘미동기화/진단 한계’를 구분해 표시한다. 서버가 알 수 없는 모바일 큐 개수를 0으로 추정하지 않는다.
- finish/syncComplete 중복·재시도·서버 재시작·종료 후 늦은 데이터에서도 idempotent하게 동작하고, 입력이 추가되면 필요한 재처리가 수행되는지 검증한다. 기대 개수가 있다면 실제 저장 개수와 차이를 드러낸다.
- 확인된 종료 요청이 있는데 ACTIVE로 남는 서버 결함이 재현되면 그 경로를 수정한다. C04에 finish 요청이 없다는 사실만으로 서버 결함 또는 사용자의 Stop을 단정하지 않는다.
- finish/syncComplete 수신, ACK, 최종 replay 대기/완료/실패를 연결해 추적할 진단을 추가한다. raw를 저장하기 전에 성공 ACK하는 회귀를 만들지 않는다.

## 5. P0: 절대 고도 없음이 실제 층 위치처럼 보이지 않게

현재 `trajectory.ts`는 절대 고도가 없으면 terrainHeight+1m 등에 점을 놓는다. C04의 672점 전체가 이 조건이었다.

- ‘절대 고도 미확정’과 ‘표시용 지면 투영’을 명시하고, 해당 선/점은 검증된 절대 고도 선과 구별한다. 툴팁에는 원시 기압 상대 고도, 절대 고도 기준/불확실성, 표시용 높이를 구분해 보여 준다.
- 현재 API에서 상대 고도 필드가 실제 원시값인지 구간 보정된 상대 Z인지 확인하고 정확히 이름 붙인다. 센서 재시작으로 잃은 높이 변화를 확정값으로 연결하지 않는다.
- 기압 상대 변화는 별도 상대 고도 그래프로 확인 가능하게 하되, 시작 높이/층수가 없는데 건물 층을 확정하지 않는다.
- 포인트·라인·현재 위치·마커·층 보기 모두 높이 fallback 규칙을 감사하고 일관되게 만든다. 검증된 기준을 얻지 못한 경우 숫자를 조작해 건물에 맞추지 않는다.
- 방향도 UNKNOWN/CONTINUITY/GPS_SHAPE_FIT와 평활화 단계를 표시한다. ‘raw→fused 거리’, GPS 보고 accuracy, 내부 confidence를 실제 위치 정확도라고 표기하지 않는다.

## 6. P1: 실제 센서 주기에 맞는 보행 검출

현재 biquad는 `/50`으로 설계된 고정 50 Hz 필터다. 별도 합성 입력에서 2Hz/0.20g 수직 운동을 60초 제공했을 때 50 Hz는 약 120걸음, 20 Hz는 0걸음이었다. 이것은 코드 결함 재현이며 C04 원인이라는 뜻은 아니다.

- 측정 timestamp의 실제 dt로 안정된 sample rate를 추정하거나 시간 기반 필터를 사용하는 방식을 선택한다. 보고 motionUpdateHz는 검증용 메타데이터이며, 도착 간격은 샘플링 간격이 아니다.
- 10/20/50 Hz, jitter, 같은 timestamp, 긴 공백, 센서 구간 전환을 처리한다. Nyquist보다 높은 cutoff를 쓰지 않고, 불안정한 추정으로 계수를 매 샘플 급변시키지 않는다. 어떤 구간에서 상태를 reset/prime할지 명확히 한다.
- gravity smoothing, priming, stationary sample window 등 샘플 개수에 의존하는 주변 로직도 시간 기준 차이를 검토한다.
- 기존 Android 50 Hz 동작을 회귀 기준으로 삼고, 필요한 알고리즘 revision/config hash를 갱신한다. fixture와 동일 입력 비교를 통과하기 전 운영 기본 알고리즘에 일괄 적용하지 않는다.

## 7. P1: 방향·보폭·GPS 가중치와 지연 진단

- C04의 처음 172초 동안 heading fit이 성립하지 않은 이유를 최소 step/fix/extent/ambiguity 조건별로 추적한다. 센서 구간/자세 전환/공백 이후 연속성 가정도 진단한다. trueNorth yaw는 휴대폰 방향이지 자동으로 보행 방향이 아니므로 offset=0을 강제하지 않는다.
- C04 GPS 409/435개 수용과 보고 accuracy 분포를 분석한다. 불확실도가 커서 잘못된 fix도 통과하는지 최종 residual과 함께 확인한다. C04 한 세션만 맞추려고 모든 iOS fix의 가중치나 좌표를 일괄 조정하지 않는다.
- iOS 학습 보폭 0.65m, Android 기본 0.72m는 서로 다른 입력 조건이다. 동일 파이프라인에서 학습 근거/신뢰도/계단·경사 분류를 비교한다. Android 값을 무조건 정답으로 덮어쓰지 않는다.
- 구간별 실제 Hz, gap, 수신 지연 p50/p95/max, 역순/중복, live에서 건너뛴 관측, 보행 수, heading 미확정 시간, 절대 고도 기준 획득 시각을 진단한다. sensor-time/arrival-time을 분리하고 집계 분모를 명시한다.
- 기본 reorder window를 5분으로 늘려 문제를 가리지 않는다. 늦은 입력은 raw 보존 후 재현 가능한 별도 replay로 검증한다. ACTIVE의 재계산이 필요하면 debounce/단일 실행/버전 경계/부하와 live state 일관성을 설계한다.
- ARKit 경로는 기존 fused 경로와 별도다. 기본 비교는 ARKit 없는 조건으로 수행하고, ARKit 결과는 tracking 품질과 좌표 정렬 상태를 표시해 별도로 비교한다.

## 8. 검증 및 산출물

필수 자동 검증:

1. ACTIVE의 publish 전방 상태와 비공개 finalized snapshot이 분리되고 snapshot이 live 상태를 바꾸지 않는다.
2. 같은 원시 입력에서 순서/지연/중복을 바꿔도 SENSOR_TIME FINAL 결과가 허용 오차 내 동일하다. AS_RECEIVED의 손실은 진단에 드러난다.
3. finish/ACK 유실/중복/late upload/server restart에서 raw 유실 및 중복이 없고 최종화 상태가 정확하다.
4. 10/20/50 Hz 보행·정지·회전·jitter·gap fixture와 기존 Android 50 Hz 회귀를 통과한다.
5. 고도 null 및 방향 UNKNOWN 표시를 검증한다. 테스트 가능한 UI 로직과 실제 프리뷰 확인을 구분해 보고한다.

실데이터 보고서는 C04/C02의 같은 시간 구간에 대해 AS_RECEIVED 전방 / SENSOR_TIME 전방 / FINAL을 비교한다. 원시 개수, 모션 공백, 검출 걸음, 보폭, heading 미확정 비율, GPS 잔차, 고도 기준, 경로 길이/점프를 기록한다. 이동 경로와 측정 기준점이 없으면 실제 정확도 수치는 산출하지 않는다.

최종 산출물: 원인별 증거와 미확인 사항, 변경 코드, 테스트 결과, 두 세션 비교 보고서, UI에서 결과를 확인하는 방법, 모바일 앱과 필요한 계약 변경. 운영 데이터 변경/배포는 별도 범위로 남기고, 여기서는 검토 가능한 코드와 격리된 실험 결과까지 완성하라.
