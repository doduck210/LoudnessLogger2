# LoudnessLogger2

`LoudnessLogger2`는 기존 `LoudnessLogging`과 분리된 Linux/C++ 프로젝트다.
첫 단계에서는 Blackmagic DeckLink SDK 콜백으로 SDI audio PCM을 연속 녹음한다.
편성표 요청, 프로그램 구간 자르기, LKFS 계산, Excel 출력은 이후 단계에서 이
프로젝트에 독립적으로 구현한다.

## 현재 동작

- DeckLink SDK에서 48 kHz 인터리브 PCM을 직접 받는다.
- SDK 콜백에서는 PCM 복사만 하고 파일 쓰기는 별도 thread가 수행한다.
- 로컬 서버 시각 기준으로 WAV를 분할한다.
- 녹음 형식은 SDI audio 1·2번 채널, 48 kHz, signed 32-bit little-endian PCM이다.
- 파일 이름과 시간 단위 분할 방식은 기존 logger와 호환된다.
  - `YYYY-MM-DD_HH.00.00.wav` (정시에 시작된 segment)
  - 프로세스가 시각 중간에 시작되면 첫 파일은 실제 시작 초를 사용한다.
- DeckLink packet time이 건너뛰거나 writer queue가 넘치면 그 구간을 무음으로
  채워 이후 오디오와 wall clock의 대응이 밀리지 않게 한다. 로그와 종료 통계에
  누락량을 남긴다.
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
  --output /mnt/raid/recording/SBS_HD \
  --segment-minutes 60
```

2채널/48 kHz/32-bit PCM은 시간당 약 1.38 GB, 하루 약 33.2 GB다. 한 시간 파일이
일반 RIFF/WAV의 4 GiB 한계보다 충분히 작으므로 60분 단위 저장이 가능하다.
채널 수와 sample depth는 실행 옵션이 아니라 프로그램 설정으로 고정되어 있다.

`--mode`를 생략하면 1080i59.94를 초기 mode로 사용하고, 지원 장치에서는 입력
format detection을 켠다. 자동 감지가 불가능한 장치에서는 `--list-modes`로 확인한
index를 `--mode INDEX`로 지정한다.

## 24/7 service

`decklink-pcm-recorder.service.example`의 사용자, 실행 파일, 저장 경로를 서버에
맞춘 뒤 systemd unit으로 설치한다. 운영 전 다음을 별도로 감시해야 한다.

- service restart 횟수와 process 생존 여부
- `dropped_frames`, `inserted_silence_frames`, `Writer failure` 로그
- mount 상태, 남은 disk 공간, inode
- DeckLink driver/firmware version과 SDI signal 유무
- 서버 timezone 및 NTP 동기화

다음 구현 단계는 파일 이름만 비교하지 않고 각 WAV의 실제 시작 시각과 sample
offset으로 편성 구간을 자르는 C++ cutter, BS.1770 loudness 계산, XLSX/CSV report
생성 순서가 적합하다.
