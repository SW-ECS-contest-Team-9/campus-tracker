# 2026-10-09 1차 배포 확인 절차

배포 대상: `1463c0e`까지. 면 공간 편집·중정 보존과 읽기 전용 감사 코드. 건물 높이·지형·도로 보정 후보를 적용하지 않는다.

## 서버 사전 확인
기존 서버 체크아웃 `/home/di-lab/Desktop/CampusTracker-Server`에서 실행한다.

```sh
cd /home/di-lab/Desktop/CampusTracker-Server
git status --short
git rev-parse HEAD
git fetch origin
```

미커밋 변경이 있으면 중단하고 보존한다. 현재 HEAD 전체 값을 복구 기준으로 기록한다. 알려진 이전 서버 커밋은 82baea2이나 현재값을 다시 확인한다.

DB의 `schema_migrations`에서 `019_mobility_spaces.sql`, `020_mobility_defaults.sql` 적용 여부와 `mobility.open_areas` 존재 여부를 확인한다. 기존 DB 접속 수단을 사용하고 비밀값은 출력·기록하지 않는다. 이번 코드 자체에는 새 마이그레이션이 없다. 누락 상태에서 전체 db:migrate를 무조건 실행하지 않는다. 러너는 모든 미적용 파일을 실행하므로 별도 변경 검토가 필요하다.

## 코드 반영 및 빌드
작업 폴더가 깨끗하고 DB 조건이 충족됐을 때:

```sh
git merge --ff-only 1463c0e
npm run build -w backend
npm run build -w frontend
```

fast-forward 실패 또는 빌드 실패 시 서비스를 새 코드로 재시작하지 않는다. 원격 브랜치 변경·서비스 실행 방식을 확인하지 않고 강제 reset 또는 프로세스 전체 kill을 하지 않는다.

## 서비스 및 기능 확인
기존 서비스 관리 방식을 먼저 확인하고 그 방식으로 반영한다. 개발 watch 서버와 배포 서비스가 중복 실행되지 않게 실제 포트 소유 프로세스를 확인한다.

- editor.html 응답, 기존 scene·terrain API 응답, 인증 후 GET /api/v1/editor/areas 응답 확인.
- 공간 목록 로딩, 기존 도로 선택·편집, 면 초안 시작·취소, 고도 색상·건물 투명도·통로 관통 표시 확인.
- 운영에 임의 시험 공간을 생성하지 않는다. 저장 검사는 이미 격리 PostGIS에서 통과했다.
- 오류 로그와 최종 서버 HEAD를 기록한 후 배포 완료로 표시한다.

## 복구
배포 전 기록한 HEAD의 코드·빌드로 기존 서비스 방식을 통해 복구한다. 이번 배포에는 새 DB 마이그레이션이나 모델 보정이 없으므로 코드 복구와 모델 데이터 복구를 혼동하지 않는다. 배포 후 사용자가 만든 면 데이터는 보존한다.

## 현재 상태
2026-10-09: 원격 main 반영·로컬 빌드·격리 DB·브라우저 fixture 검증 완료. 서버 SSH 명령은 자동 승인 검토에서 거부돼 서버 HEAD/DB/서비스 확인과 실제 배포가 미완료다.
