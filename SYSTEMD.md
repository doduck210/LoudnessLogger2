# systemd 녹음·웹 서비스 등록

recorder와 Node 웹 서버를 각각 systemd 서비스로 등록한다. 둘 다 서버 부팅 시
자동으로 시작하지만, 한쪽에 장애가 발생해도 다른 서비스는 영향을 받지 않는다.

## 1. 사전 확인

프로젝트를 빌드하고 DeckLink와 HDD를 확인한다.

```bash
cd /home/duck/Codes/LoudnessLogger2
make

./decklink_pcm_recorder --list-devices
findmnt /mnt/hdd
test -w /mnt/hdd/recordings
test -w /mnt/hdd/schedules
test -w /mnt/hdd/reports
node --version
command -v node
```

프로젝트 경로는 실제 clone한 위치로 바꾼다. `findmnt`에는 실제 HDD 장치가
표시되어야 하고 `test` 명령은 오류 없이 끝나야 한다.

로그 디렉터리도 미리 만든다.

```bash
mkdir -p /home/duck/Codes/LoudnessLogger2/logs
```

## 2. 녹음 서비스 파일 작성

DeckLink 입력 하나마다 서비스를 하나씩 만든다. DeckLink SDK 장치 번호는
`--list-devices`에 표시되는 0부터 시작하는 번호이므로, 이 서버에서 물리 포트
2·3·4는 각각 `--device 1`, `--device 2`, `--device 3`이다.

먼저 저장 디렉터리를 만든다.

```bash
mkdir -p \
  /mnt/hdd/recordings/decklink2 \
  /mnt/hdd/recordings/decklink3 \
  /mnt/hdd/recordings/decklink4
```

포트 2 서비스 파일을 관리자 권한으로 연다.

```bash
sudo nano /etc/systemd/system/loudness-recorder-port2.service
```

아래 내용을 붙여 넣는다.

```ini
[Unit]
Description=LoudnessLogger2 DeckLink port 2 recorder
After=local-fs.target
RequiresMountsFor=/mnt/hdd
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=duck
Group=duck
WorkingDirectory=/home/duck/Codes/LoudnessLogger2
ExecStartPre=/usr/bin/test -w /mnt/hdd/recordings/decklink2
ExecStart=/home/duck/Codes/LoudnessLogger2/decklink_pcm_recorder --device 1 --output /mnt/hdd/recordings/decklink2 --segment-minutes 60 --queue-mib 64 --lkfs-filter rbj
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0002
StandardOutput=append:/home/duck/Codes/LoudnessLogger2/logs/recorder-port2.log
StandardError=append:/home/duck/Codes/LoudnessLogger2/logs/recorder-port2.log

[Install]
WantedBy=multi-user.target
```

포트 3과 4는 이 파일을 복사한 뒤 아래 값만 바꾼다.

| 서비스 | `--device` | `--output` | 로그 |
|---|---:|---|---|
| `loudness-recorder-port2.service` | `1` | `/mnt/hdd/recordings/decklink2` | `recorder-port2.log` |
| `loudness-recorder-port3.service` | `2` | `/mnt/hdd/recordings/decklink3` | `recorder-port3.log` |
| `loudness-recorder-port4.service` | `3` | `/mnt/hdd/recordings/decklink4` | `recorder-port4.log` |

장치 순서는 카드 구성에 따라 달라질 수 있으므로 새 서버에서는 반드시
`./decklink_pcm_recorder --list-devices` 결과를 먼저 확인한다.

서버의 로그인 사용자가 `duck`이 아니라면 `User=`와 `Group=`을 실제 계정으로
바꾼다. 프로젝트 위치가 다르면 `WorkingDirectory=`, `ExecStart=`,
`StandardOutput=`과 `StandardError=`의 프로젝트 경로를 바꾼다. 저장 위치가
`/mnt/hdd`가 아니라면 `RequiresMountsFor`와 두 `ExecStartPre` 경로도 실제
위치로 바꾼다.

저장 후 nano는 `Ctrl+O`, `Enter`, `Ctrl+X` 순서로 종료한다.

## 3. 웹 서비스 파일 작성

다음 파일을 관리자 권한으로 연다.

```bash
sudo nano /etc/systemd/system/loudness-web.service
```

아래 내용을 붙여 넣는다.

```ini
[Unit]
Description=LoudnessLogger2 web console
After=network-online.target
Wants=network-online.target
RequiresMountsFor=/mnt/hdd
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=duck
Group=duck
WorkingDirectory=/home/duck/Codes/LoudnessLogger2/web
Environment=NODE_ENV=production
ExecStart=/home/duck/.nvm/versions/node/v20.9.0/bin/node /home/duck/Codes/LoudnessLogger2/web/server.mjs
Restart=always
RestartSec=5
TimeoutStopSec=15
KillSignal=SIGTERM
UMask=0022
StandardOutput=append:/home/duck/Codes/LoudnessLogger2/logs/web.log
StandardError=append:/home/duck/Codes/LoudnessLogger2/logs/web.log

[Install]
WantedBy=multi-user.target
```

프로젝트 위치나 사용자 계정이 다르면 녹음 서비스와 마찬가지로 경로,
`User=`와 `Group=`을 바꾼다. Node 경로는 앞에서 실행한 `command -v node`의
출력으로 `ExecStart=` 첫 번째 경로를 바꾼다. NVM의 Node 버전을 변경하면 이 경로도
새 버전에 맞게 수정해야 한다. 웹에서 감시할 채널 이름과 녹음 경로, 리포트 계산
채널, 편성표 API 주소는 웹의 **설정** 화면에서 관리하며 `web/settings.json`에
저장된다. listen 주소, 포트, 편성·리포트 저장 경로는 `web/server.mjs` 상단의
`serverSettings`에서 설정한다.
`0.0.0.0:8080`은 같은 네트워크의 다른 PC에서도 접속할 수 있는 설정이다. 인증
기능을 추가하기 전에는 신뢰할 수 있는 내부망에서만 사용한다.

## 4. 등록하고 자동 시작

```bash
sudo systemd-analyze verify \
  /etc/systemd/system/loudness-recorder-port2.service \
  /etc/systemd/system/loudness-recorder-port3.service \
  /etc/systemd/system/loudness-recorder-port4.service \
  /etc/systemd/system/loudness-web.service

sudo systemctl daemon-reload
sudo systemctl enable --now \
  loudness-recorder-port2.service \
  loudness-recorder-port3.service \
  loudness-recorder-port4.service \
  loudness-web.service
```

`enable`은 부팅 시 자동 시작을 등록하고, `--now`는 현재 서버에서도 즉시
두 서비스를 시작한다.

## 5. 정상 동작 확인

```bash
systemctl status \
  loudness-recorder-port2.service \
  loudness-recorder-port3.service \
  loudness-recorder-port4.service \
  --no-pager
systemctl status loudness-web.service --no-pager
tail -n 100 /home/duck/Codes/LoudnessLogger2/logs/recorder-port2.log
tail -n 100 /home/duck/Codes/LoudnessLogger2/logs/recorder-port3.log
tail -n 100 /home/duck/Codes/LoudnessLogger2/logs/recorder-port4.log
tail -n 100 /home/duck/Codes/LoudnessLogger2/logs/web.log
```

실시간 로그는 다음 명령으로 확인한다.

```bash
tail -f /home/duck/Codes/LoudnessLogger2/logs/recorder-port2.log \
  /home/duck/Codes/LoudnessLogger2/logs/recorder-port3.log \
  /home/duck/Codes/LoudnessLogger2/logs/recorder-port4.log \
  /home/duck/Codes/LoudnessLogger2/logs/web.log
```

정상 동작 중에는 `/mnt/hdd/recordings/decklink2`부터 `decklink4`까지 각
디렉터리의 현재 WAV와 M-LKFS CSV 크기가 계속 증가한다.

서비스 실행 자체가 실패한 경우에는 systemd journal도 확인한다.

```bash
journalctl -u loudness-recorder-port2.service -n 100 --no-pager
journalctl -u loudness-recorder-port3.service -n 100 --no-pager
journalctl -u loudness-recorder-port4.service -n 100 --no-pager
journalctl -u loudness-web.service -n 100 --no-pager
```

웹 브라우저에서는 다음 주소로 접속한다.

```text
http://SERVER_IP:8080
```

## 6. 로그 파일 자동 정리

별도의 `logrotate` 등록은 필요하지 않다. 웹 설정의 채널별 **레코더 로그**
보관기간과 공통 **웹 운영 로그** 보관기간을 사용한다. 웹 서버가 자동 리포트
예약 시각에 현재 `logs/*.log`를 날짜별 `.gz` 파일로 압축하고, 원본 로그를
비운 뒤 설정 기간보다 오래된 압축 파일을 삭제한다.

레코더 서비스의 `StandardOutput`/`StandardError` 파일명과 웹 설정에 표시되는
레코더 로그 파일명이 반드시 같아야 한다. 이미
`/etc/logrotate.d/loudness-logger`를 별도로 등록했다면 이중 회전을 피하도록
해당 logrotate 설정은 제거한다.

## 7. 기본 관리 명령

```bash
sudo systemctl start loudness-recorder-port2.service
sudo systemctl stop loudness-recorder-port2.service
sudo systemctl restart loudness-recorder-port2.service

sudo systemctl start loudness-web.service
sudo systemctl stop loudness-web.service
sudo systemctl restart loudness-web.service
```

서비스가 실행 중일 때 `decklink_pcm_recorder`를 터미널에서 별도로 실행하면
DeckLink 입력이 충돌할 수 있으므로 동시에 실행하지 않는다.

소스를 업데이트했다면 프로젝트에서 다시 빌드하고 서비스를 재시작한다.

```bash
cd /home/duck/Codes/LoudnessLogger2
make
sudo systemctl restart \
  loudness-recorder-port2.service \
  loudness-recorder-port3.service \
  loudness-recorder-port4.service \
  loudness-web.service
```
