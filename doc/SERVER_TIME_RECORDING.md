# 서버 시각 기반 녹음

DeckLink의 48 kHz는 오디오 장치의 clock이고 서버 clock과 완전히 같지는 않다. 예전
방식처럼 한 시간마다 항상 172,800,000 frame을 쓰면 장기간에 걸쳐 파일 경계가 서버
정시에서 조금씩 이동할 수 있다.

현재 recorder는 video frame의 DeckLink hardware reference timestamp, audio packet
time, Linux 서버 시각을 연결한다. 시작 시 약 5초를 보정에 쓰고 이후 매초 가장
지연이 적은 관측값으로 최근 30분의 clock 비율을 갱신한다. PCM을 resample하거나
sample을 임의로 빼지 않고, 서버 정시를 처음 통과하는 sample에서 WAV만 교체한다.

그 결과는 다음과 같다.

- 파일명과 분할 경계는 KST 서버 시각에 맞는다.
- 한 시간 파일의 sample 수는 장치 clock 차이만큼 몇 frame 달라질 수 있다.
- M-LKFS의 400 ms window와 100 ms hop은 원본 sample 기준으로 계속 일정하다.
- 각 M-LKFS 행에는 해당 sample block의 보정된 서버 시각이 기록된다.
- WAV 옆의 `.timing.csv`를 이용해 편성 오디오도 서버 시각 기준으로 자른다.

종료 로그의 `hardware_timestamps`가 `audio_packets`와 비슷하고
`Server clock: locked=yes`이면 hardware 기준 시각 보정이 동작한 것이다.
