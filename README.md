# LoudnessLogger2

`LoudnessLogger2`는 기존 `LoudnessLogging`과 분리된 Linux/C++ 프로젝트다.
첫 단계에서는 Blackmagic DeckLink SDK 콜백으로 SDI audio PCM을 연속 녹음한다.
편성표 요청, 프로그램 구간 자르기, LKFS 계산, Excel 출력은 이후 단계에서 이
프로젝트에 독립적으로 구현한다.

## 현재 동작

- DeckLink SDK에서 48 kHz 인터리브 PCM을 직접 받는다.
- SDK 콜백에서는 PCM 복사만 하고 파일 쓰기는 별도 thread가 수행한다.
- 같은 writer thread에서 연속 K-weighting과 M-LKFS 계산을 수행한다. 기본 필터는
  과거 pyloudnorm 기본값과 같은 RBJ이며 `--lkfs-filter deman`도 선택할 수 있다.
- M-LKFS는 게이팅하지 않은 400 ms 창을 서울 시각 100 ms 격자마다 계산한다.
  결과는 서울 정시 기준 한 시간 단위 `*_mlkfs.csv`에 `double` 정밀도로 저장한다.
- 프로세스 시작 직후에는 다음 100 ms 경계 전까지의 최대 4,800 sample frame을
  버리고 시간축을 정확한 `.0`/`.1` 격자에 맞춘다. 이후 정시 파일의 첫 M 블록은
  항상 `HH:00:00.0`에서 시작한다.
- 서버 timezone 설정과 관계없이 서울 시각(KST, UTC+09:00) 기준으로 WAV 파일명을
  만들고 정시 경계에서 분할한다.
- 녹음 형식은 SDI audio 1·2번 채널, 48 kHz, signed 32-bit little-endian PCM이다.
- 파일 이름과 시간 단위 분할 방식은 기존 logger와 호환된다.
  - `YYYY-MM-DD_HH.00.00.wav` (정시에 시작된 segment)
  - 프로세스가 시각 중간에 시작되면 첫 파일은 실제 시작 초를 사용한다.
- DeckLink packet time이 건너뛰거나 writer queue가 넘치면 그 구간을 무음으로
  채워 이후 오디오와 wall clock의 대응이 밀리지 않게 한다. 로그와 종료 통계에
  누락량을 남긴다. 삽입된 무음은 WAV와 M-LKFS 계산에 똑같이 적용된다.
- WAV 헤더를 5초마다 갱신하므로 비정상 종료 파일도 대부분 복구 없이 읽을 수 있다.
- 같은 파일명이 이미 있으면 덮어쓰지 않고 `_partNN` suffix를 붙인다.
- Audio packet이 5초 동안 도착하지 않으면 경고하고, 단절이 계속되면 30초마다
  반복한다. Packet 수신이 재개되면 복구 메시지를 출력한다.

## Build

빌드에 필요한 DeckLink SDK Linux 헤더와 dispatch source는
`third_party/decklink`에 포함되어 있다. 따라서 별도 SDK 경로는 필요 없다.
실행할 Linux 서버에는 DeckLink 카드와 Blackmagic Desktop Video driver가 설치되어
있어야 한다. driver가 runtime library인 `libDeckLinkAPI.so`를 제공한다.

별도 build system 생성 단계 없이 Makefile이 `g++`를 직접 실행한다.

```bash
make
```

프로젝트 루트에 `decklink_pcm_recorder`가 생성된다. 생성한 실행 파일 정리는
`make clean`을 사용한다.

## Run

장치와 입력 mode 확인:

```bash
./decklink_pcm_recorder --list-devices
./decklink_pcm_recorder --device 0 --list-modes
```

SDI audio 1·2번 채널을 32-bit PCM으로 한 시간 단위 녹음:

```bash
./decklink_pcm_recorder \
  --device 0 \
  --segment-minutes 60 \
  --lkfs-filter rbj
```

`--output`을 생략하면 `/mnt/hdd/recordings`에 저장한다. 다른 경로를 사용할 때만
`--output DIRECTORY`를 지정한다.

C++ 프로그램의 기본 저장 위치를 바꾸려면 `include/Config.h` 상단의 다음 한 줄만
수정하고 `make`로 다시 빌드한다.

```cpp
inline const std::filesystem::path kStorageRoot = "/mnt/hdd";
```

`recordings`, `schedules`, `reports` 하위 경로가 모두 함께 변경된다.

2채널/48 kHz/32-bit PCM은 시간당 약 1.38 GB, 하루 약 33.2 GB다. 한 시간 파일이
일반 RIFF/WAV의 4 GiB 한계보다 충분히 작으므로 60분 단위 저장이 가능하다.
채널 수와 sample depth는 실행 옵션이 아니라 프로그램 설정으로 고정되어 있다.

M-LKFS CSV는 WAV segment 길이와 관계없이 한 시간 단위다. 프로세스 시작 후 첫
부분 파일은 WAV처럼 실제 시작 시각을 사용하고, 그다음부터 서울 정시에 분할한다.
한 시간에 36,000개 값이 기록되며 크기는 대략 4 MB다. 파일명과 열은 다음과 같다.

```text
2026-07-22_12.00.00_mlkfs.csv

start_time_kst,end_time_kst,start_sample,end_sample,mlkfs,filter
2026-07-22T12:00:00.0+09:00,2026-07-22T12:00:00.4+09:00,0,19200,-23.035004560596764,RBJ
```

같은 시간대 파일이 이미 있으면 WAV와 마찬가지로 `_partNN`을 붙이며 덮어쓰지 않는다.
CSV는 5초마다 flush한다. `--lkfs-filter`를 생략하면 `rbj`이고 `deman`도 가능하다.

`--mode`를 생략하면 1080i59.94를 초기 mode로 사용하고, 지원 장치에서는 입력
format detection을 켠다. 자동 감지가 불가능한 장치에서는 `--list-modes`로 확인한
index를 `--mode INDEX`로 지정한다.

## 24/7 service

24/7 자동 시작과 재시작을 위한 systemd 등록 방법은
[`SYSTEMD.md`](SYSTEMD.md)를 참고한다.

## Daily loudness report

`loudness_report`는 지정 날짜의 편성표를 내부 API에서 받아 각 편성 구간에 완전히
포함되는 M-LKFS 블록만 선택한다. 저장된 M 값을 에너지로 복원하고 −70 LKFS
absolute gate와 −10 LU relative gate를 적용해 I-LKFS를 계산한다.
CSV 표시 시각의 반올림 오차에 의존하지 않고 `start_sample`/`end_sample`로 100 ms
블록 시간축을 재구성하므로 기존 장시간 로그도 정확히 처리한다.

```bash
make

./loudness_report \
  --date 2026-07-23
```

기본 녹음 경로는 `/mnt/hdd/recordings`, 리포트는
`/mnt/hdd/reports/SBS_HD_Loudness_Report_2026-07-23.xlsx`, 계산에 사용한 편성표
원문은 `/mnt/hdd/schedules/SBS_HD_Schedule_2026-07-23.json`이다. `--output`의
확장자를 `.csv`로 지정하면 CSV 리포트를 생성한다.

```bash
./loudness_report \
  --date 2026-07-23 \
  --recordings /another/recordings \
  --output /another/reports/SBS_HD_Loudness_Report_2026-07-23.xlsx
```

기존 파일은 기본적으로 덮어쓰지 않는다. 의도적으로 교체할 때만 `--force`를 쓴다.
API에 접근할 수 없는 개발 환경에서는 `--schedule-json saved.json`으로 저장된 응답을
사용할 수 있다. 저장할 편성표 경로는 `--schedule-output FILE`로 변경할 수 있다.
편성 구간의 400 ms 블록이 하나라도 빠지면 해당 ILKFS 셀은 비우고 프로그램은 경고와
종료 코드 2를 반환한다.

## Web console

Node.js 20 이상이 설치되어 있으면 별도 패키지 설치 없이 운영 콘솔을 실행할 수 있다.

```bash
cd web
npm start
```

기본적으로 모든 네트워크 인터페이스의 8080 포트에서 대기하므로 브라우저에서
`http://SERVER_IP:8080`으로 접속한다. 편성표는 채널별로
`/mnt/hdd/schedules/{채널이름}_Schedule_YYYY-MM-DD.json`에 저장된다. 저장된 파일이
없으면 화면에서 해당 채널의 API 편성표를 받아 만들 수 있고, 수정 저장과 API
새로고침은 같은 파일을 원자적으로 교체한다. 리포트는
`/mnt/hdd/reports/{채널이름}_Loudness_Report_YYYY-MM-DD.xlsx`로 생성된다.
리포트 생성 시 같은 편성 경계로 원본 PCM을 잘라
`/mnt/hdd/reports/program_audio/{채널이름}/YYYY-MM-DD/`에 편성별 WAV도 생성한다.
리포트 파일은 M-LKFS CSV만 사용해 먼저 빠르게 완성하고, 편성 오디오는 별도의
C++ 프로세스가 백그라운드 큐에서 한 채널씩 생성한다. 진행 상태와 실시간 로그는
웹의 **Loudness 리포트 → 편성 오디오 작업**에서 확인한다. 웹 편성표의 재생
버튼으로 완성된 WAV를 브라우저에서 바로 확인할 수 있다. 여러 시간짜리 편성은
시간별 원본 WAV를 끊김 없이 이어 붙이며, 표준 WAV의 4 GiB 한도를 넘는 장시간
편성은 `_part01`, `_part02`처럼 자동 분할한다. 원본과 같은 48 kHz, 2채널,
32-bit PCM이라 재인코딩에 따른 음질 변화는 없다.

편성별 WAV는 해당 시간대 원본과 거의 같은 용량을 추가로 사용한다. 현재 포맷은
채널당 하루 약 33.2 GB이므로 리포트 대상이 두 채널이면 하루 약 66.4 GB가
추가된다. 필요하지 않으면 명령행에서 `--no-audio`로 생성을 끌 수 있다.

웹의 **설정** 화면에서 감시할 채널 이름과 녹음 경로를 여러 개 등록할 수 있다.
설정은 `web/settings.json`에 저장되며 재시작 후에도 유지된다. 기본값은
`/mnt/hdd/recordings/decklink2`, `decklink3`, `decklink4` 세 채널이다.
각 채널을 리포트 대상으로 선택할 수 있다. 모든 채널은 동일한 HD 편성표를
사용하며 API에는 항상 `UHDSchedule=False`를 전달한다. 편성표 API 주소와 자동
리포트 실행 시각도 설정 화면에서 지정한다.
자동 리포트는 기본적으로 매일 08:00 KST에 모든 리포트 대상 채널의 전날 편성표를
받아 채널별 리포트를 순차 생성한다. 실행 상태는 `web/scheduler-state.json`에
저장되어 웹서버 재시작 시 같은 날짜가 중복 실행되지 않는다. listen 주소와 포트,
편성·리포트 저장 경로는 `web/server.mjs` 상단의 `serverSettings`에서 변경한다.

설정 화면에서 채널마다 원본 녹음 WAV, M-LKFS CSV, 편성별 WAV, 편성표 JSON,
리포트 XLSX와 레코더 로그의 보관기간을 각각 0~3650일로 지정한다. 웹 운영
로그는 전체 서버에 하나이므로 공통 보관기간으로 설정한다. 0일은 자동 삭제하지
않는다는 뜻이다. 여러 채널이 같은 원본 녹음 경로나 레코더 로그를 사용하면
그중 가장 긴 보관기간을 적용하며, 하나라도 0일이면 해당 공유 자료는 자동
삭제하지 않는다.
자동 리포트가 활성화되어 있으면 같은 예약 시각에 설정 일수보다 오래된 방송일
자료를 정리한 뒤 전날 리포트를 생성한다. 실행 중인 리포트·오디오 작업 날짜와
정해진 파일명 형식이 아닌 파일은 삭제하지 않는다. 최근 정리 결과는 설정 화면과
`web/scheduler-state.json`에서 확인한다.

`logs/*.log`는 실행 중인 서비스가 계속 쓰는 파일이므로 직접 삭제하지 않는다.
매일 정리 시각에 현재 내용을 날짜가 붙은 `.gz` 파일로 압축한 뒤 원본 로그를
비우고, 설정한 기간보다 오래된 압축 로그만 삭제한다. `settings.json`과
`scheduler-state.json`은 날짜별로 쌓이지 않고 같은 파일을 계속 덮어쓴다.

웹의 **채널 캘린더**에서는 채널별 월간 상태를 확인한다. 날짜마다 녹음 데이터,
편성표, 리포트, 편성 오디오 보유 여부가 표시되며 날짜를 누르면 API 편성표 받기,
편성표 열기·수정, 리포트 생성과 다운로드 작업을 바로 실행할 수 있다. 달력 아래
편성표에는 생성된 XLSX의 I-LKFS가 행별로 표시되며, 편성 오디오가 있으면 같은
행에서 WAV를 스트리밍 재생하거나 다운로드할 수 있다.
