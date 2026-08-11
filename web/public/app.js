const state = {
  view: "dashboard",
  schedule: null,
  date: "",
  dirty: false,
  filter: "",
  jobTimer: null,
  settings: null,
  scheduler: null,
  channelId: "",
  reportChannels: [],
  audioFiles: new Map(),
  audioFilesSignature: "",
  audioJobTimer: null,
  programAudioTimer: null,
  selectedAudioJobId: "",
  calendarMonth: "",
  calendarDate: "",
  calendarData: null,
  calendarTimer: null,
  calendarContentKey: "",
  calendarContentRequest: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function applyTheme(theme, persist = true) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected;
  const isLight = selected === "light";
  $("#theme-toggle-icon").textContent = isLight ? "☾" : "☀";
  $("#theme-toggle-label").textContent = isLight ? "다크" : "라이트";
  $("#theme-toggle").title = isLight
    ? "다크 모드로 전환"
    : "Gruvbox 라이트 모드로 전환";
  $("#theme-toggle").setAttribute("aria-label", $("#theme-toggle").title);
  $("#theme-color").content = isLight ? "#fbf1c7" : "#091018";
  if (persist) {
    try {
      localStorage.setItem("loudness-theme", selected);
    } catch {
      // The theme still works when browser storage is unavailable.
    }
  }
}

applyTheme(document.documentElement.dataset.theme, false);

function yesterdayKst() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const current = new Date(`${values.year}-${values.month}-${values.day}T00:00:00Z`);
  current.setUTCDate(current.getUTCDate() - 1);
  return current.toISOString().slice(0, 10);
}

function todayKst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return [h, m, s].map((part) => String(part).padStart(2, "0")).join(":");
}

function parseDuration(value) {
  const match = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function localInputValue(startTime) {
  return startTime.replace(" ", "T");
}

function apiTimeValue(inputValue) {
  return inputValue.replace("T", " ");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function notify(message, isError = false) {
  const node = $("#global-message");
  node.textContent = message;
  node.hidden = false;
  node.classList.toggle("error", isError);
  node.classList.toggle("success", !isError);
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (node.hidden = true), 5000);
}

function switchView(view) {
  state.view = view;
  clearInterval(state.audioJobTimer);
  clearInterval(state.programAudioTimer);
  clearInterval(state.calendarTimer);
  state.audioJobTimer = null;
  state.programAudioTimer = null;
  state.calendarTimer = null;
  const titles = {
    dashboard: "운영 대시보드",
    calendar: "채널 캘린더",
    schedule: "편성표 관리",
    reports: "Loudness 리포트",
    logs: "운영 로그",
    settings: "시스템 설정",
  };
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}-view`));
  $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  $("#page-title").textContent = titles[view];
  if (view === "dashboard") loadDashboard();
  if (view === "calendar") {
    updateArchiveDateLimits();
    loadCalendar();
    state.calendarTimer = setInterval(loadCalendar, 5_000);
  }
  if (view === "reports") {
    loadReports();
    state.audioJobTimer = setInterval(loadAudioJobs, 1_000);
  }
  if (view === "logs") loadLogs();
  if (view === "schedule") {
    state.programAudioTimer = setInterval(() => {
      const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(
        document.activeElement?.tagName,
      );
      if (!state.dirty && !editing && state.channelId && state.date) {
        void loadProgramAudio(state.channelId, state.date);
      }
    }, 3_000);
  }
  if (view === "settings") loadSettings();
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    $("#server-time").textContent = data.serverTimeKst;
    updateReportChannelOptions(data.reportChannels);
    renderRecorders(data.recorders);
    $("#disk-free").textContent = formatBytes(data.storage.availableBytes);
    $("#disk-total").textContent = formatBytes(data.storage.totalBytes);
    $("#disk-percent").textContent = `${data.storage.usedPercent.toFixed(1)}% USED`;
    $("#disk-progress").style.width = `${Math.min(100, data.storage.usedPercent)}%`;
    $("#days-left").textContent = `${Math.floor(data.storage.estimatedDaysRemaining)}일`;
    $("#report-count").textContent = data.counts.reports;
    $("#schedule-count").textContent = data.counts.schedules;
    $("#recording-count").textContent = data.counts.recordingFiles;
    renderFileRows($("#recent-reports"), data.recentReports);
  } catch (error) {
    notify(error.message, true);
  }
}

function updateReportChannelOptions(channels) {
  state.reportChannels = channels;
  for (const selector of [
    "#dashboard-channel",
    "#schedule-channel",
    "#calendar-channel",
  ]) {
    const select = $(selector);
    const current = select.value;
    select.replaceChildren(
      ...channels.map((channel) => {
        const option = document.createElement("option");
        option.value = channel.id;
        option.textContent = channel.name;
        return option;
      }),
    );
    select.value = channels.some((channel) => channel.id === current)
      ? current
      : channels[0]?.id || "";
  }
}

function shiftMonth(month, amount) {
  const value = new Date(`${month}-01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + amount);
  return value.toISOString().slice(0, 7);
}

function shiftDate(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function updateArchiveDateLimits() {
  const latestDate = yesterdayKst();
  const from = $("#calendar-archive-from");
  const to = $("#calendar-archive-to");
  from.max = latestDate;
  to.max = latestDate;
  if (!to.value || to.value > latestDate) to.value = latestDate;
  if (!from.value) from.value = shiftDate(latestDate, -89);
  if (from.value > latestDate) from.value = latestDate;
}

async function loadCalendar() {
  const channelId =
    $("#calendar-channel").value || state.reportChannels[0]?.id || "";
  if (!channelId) return;
  if (!state.calendarMonth) state.calendarMonth = todayKst().slice(0, 7);
  try {
    const data = await api(
      `/api/calendar?channelId=${encodeURIComponent(channelId)}` +
        `&month=${encodeURIComponent(state.calendarMonth)}`,
    );
    if (
      $("#calendar-channel").value !== channelId ||
      state.calendarMonth !== data.month
    ) {
      return;
    }
    state.calendarData = data;
    if (
      !state.calendarDate ||
      !state.calendarDate.startsWith(`${data.month}-`)
    ) {
      const yesterday = yesterdayKst();
      state.calendarDate = yesterday.startsWith(`${data.month}-`)
        ? yesterday
        : "";
    }
    renderCalendar();
  } catch (error) {
    notify(error.message, true);
  }
}

function renderCalendar() {
  const data = state.calendarData;
  if (!data) return;
  $("#calendar-month-title").textContent =
    new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${data.month}-01T00:00:00Z`));
  const grid = $("#calendar-grid");
  const cells = [];
  for (let index = 0; index < data.firstWeekday; ++index) {
    const blank = document.createElement("div");
    blank.className = "calendar-day blank";
    cells.push(blank);
  }
  const today = todayKst();
  for (const day of data.days) {
    const button = document.createElement("button");
    button.className =
      "calendar-day" +
      (day.date === today ? " today" : "") +
      (day.date === state.calendarDate ? " selected" : "");
    const number = document.createElement("strong");
    number.textContent = String(Number(day.date.slice(-2)));
    const marks = document.createElement("div");
    marks.className = "calendar-marks";
    const statuses = [
      ["recording", day.hasRecording, "녹음"],
      ["schedule", day.hasSchedule, "편성"],
      ["report", day.hasReport, "리포트"],
      [
        "audio",
        day.hasAudio || ["queued", "running"].includes(day.audioJobState),
        day.audioJobState === "running"
          ? "오디오 생성 중"
          : day.audioJobState === "queued"
            ? "오디오 대기"
            : "오디오",
      ],
    ];
    for (const [className, visible, label] of statuses) {
      if (!visible) continue;
      const mark = document.createElement("span");
      mark.className =
        className +
        (["queued", "running"].includes(day.audioJobState) &&
        className === "audio"
          ? " working"
          : "");
      mark.textContent = label;
      marks.append(mark);
    }
    button.append(number, marks);
    button.addEventListener("click", () => {
      state.calendarDate = day.date;
      renderCalendar();
    });
    cells.push(button);
  }
  while (cells.length % 7 !== 0) {
    const blank = document.createElement("div");
    blank.className = "calendar-day blank";
    cells.push(blank);
  }
  grid.replaceChildren(...cells);
  renderCalendarDay();
}

function renderCalendarDay() {
  const day = state.calendarData?.days.find(
    (candidate) => candidate.date === state.calendarDate,
  );
  const buttons = [
    "#calendar-open-schedule",
    "#calendar-fetch-schedule",
    "#calendar-create-report",
  ];
  if (!day) {
    $("#calendar-day-title").textContent = "날짜를 선택하세요";
    $("#calendar-day-channel").textContent =
      state.calendarData?.channelName || "채널별 작업 상태가 표시됩니다.";
    for (const selector of buttons) $(selector).disabled = true;
    $("#calendar-download-report").hidden = true;
    renderCalendarDetail(null);
    return;
  }
  $("#calendar-day-title").textContent = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${day.date}T00:00:00Z`));
  $("#calendar-day-channel").textContent = state.calendarData.channelName;
  const audioStatus =
    day.audioJobState === "running"
      ? "생성 중"
      : day.audioJobState === "queued"
        ? "대기 중"
        : day.audioJobState === "failed"
          ? "생성 실패"
          : day.audioJobState === "warning"
            ? "일부 누락"
            : day.hasAudio
              ? "완료"
              : "없음";
  const values = [
    day.hasRecording ? "있음" : "없음",
    day.hasSchedule ? "저장됨" : "없음",
    day.hasReport ? "완료" : "없음",
    audioStatus,
  ];
  $$("#calendar-day-status strong").forEach((node, index) => {
    node.textContent = values[index];
    node.className =
      values[index] === "없음" || values[index].includes("실패")
        ? "missing"
        : values[index].includes("중") || values[index] === "대기 중"
          ? "working"
          : "ready";
  });
  $("#calendar-open-schedule").disabled = !day.hasSchedule;
  $("#calendar-fetch-schedule").disabled = false;
  $("#calendar-create-report").disabled = !day.hasSchedule;
  const download = $("#calendar-download-report");
  download.hidden = !day.hasReport;
  if (day.reportName) {
    download.href =
      `/api/reports/${encodeURIComponent(day.reportName)}/download`;
  }
  renderCalendarDetail(day);
}

function renderCalendarDetail(day) {
  const scheduleNode = $("#calendar-schedule-preview");
  const reportNode = $("#calendar-report-preview");
  const open = $("#calendar-detail-open-schedule");
  if (!day || !state.calendarData) {
    state.calendarContentKey = "";
    scheduleNode.className = "calendar-preview-empty";
    scheduleNode.textContent = "날짜를 선택하면 편성표가 표시됩니다.";
    reportNode.className = "calendar-preview-empty";
    reportNode.textContent = "날짜를 선택하면 리포트 상태가 표시됩니다.";
    open.disabled = true;
    return;
  }

  $("#calendar-detail-title").textContent =
    `${day.date} · ${state.calendarData.channelName}`;
  open.disabled = !day.hasSchedule;
  renderCalendarReportPreview(day);

  const key = [
    state.calendarData.channelId,
    day.date,
    day.hasSchedule,
    day.reportName || "",
    day.hasAudio,
    day.audioJobState || "",
  ].join(":");
  if (key === state.calendarContentKey) return;
  state.calendarContentKey = key;
  const request = ++state.calendarContentRequest;
  if (!day.hasSchedule) {
    scheduleNode.className = "calendar-preview-empty";
    scheduleNode.textContent =
      "저장된 편성표가 없습니다. 오른쪽의 ‘API 편성표 받기’를 이용하세요.";
    return;
  }
  scheduleNode.className = "calendar-preview-empty";
  scheduleNode.textContent = "편성표와 리포트 결과를 불러오는 중입니다.";
  const channelId = state.calendarData.channelId;
  const scheduleRequest = api(
    `/api/schedule?channelId=${encodeURIComponent(channelId)}` +
      `&date=${encodeURIComponent(day.date)}`,
  );
  const reportRequest = day.hasReport
    ? api(
        `/api/report-data?channelId=${encodeURIComponent(channelId)}` +
          `&date=${encodeURIComponent(day.date)}`,
      ).catch(() => null)
    : Promise.resolve(null);
  const audioRequest = api(
    `/api/program-audio?channelId=${encodeURIComponent(channelId)}` +
      `&date=${encodeURIComponent(day.date)}`,
  ).catch(() => []);
  void Promise.all([scheduleRequest, reportRequest, audioRequest])
    .then(([schedule, report, audioFiles]) => {
      if (request !== state.calendarContentRequest) return;
      renderCalendarSchedulePreview(
        schedule,
        report,
        audioFiles,
        channelId,
        day.date,
      );
    })
    .catch((error) => {
      if (request !== state.calendarContentRequest) return;
      state.calendarContentKey = "";
      scheduleNode.className = "calendar-preview-empty";
      scheduleNode.textContent = `편성표를 열 수 없습니다: ${error.message}`;
    });
}

function openAudioPreview({
  url,
  fileName,
  title,
  date,
  startTime,
  duration,
  partLabel,
}) {
  const player = $("#audio-preview-player");
  player.pause();
  player.src = url;
  player.load();
  $("#audio-preview-title").textContent = title || "편성 오디오";
  $("#audio-preview-meta").textContent =
    `${date} ${startTime} · ${formatDuration(duration)}` +
    (partLabel ? ` · 파일 ${partLabel}` : "");
  $("#audio-preview-file").textContent = fileName;
  const download = $("#audio-preview-download");
  download.href = url;
  download.download = fileName;
  $("#audio-playback-rate").value = "1";
  player.playbackRate = 1;
  $("#audio-preview-dialog").showModal();
}

function renderCalendarSchedulePreview(
  schedule,
  report,
  audioFiles,
  channelId,
  date,
) {
  const container = $("#calendar-schedule-preview");
  const reportRows = new Map(
    (report?.rows || []).map((row) => [
      `${row.startTime}|${row.programId || ""}`,
      row,
    ]),
  );
  const audioByIndex = new Map();
  for (const file of audioFiles) {
    const match = /^(\d{3})_/.exec(file.name);
    if (!match) continue;
    const index = Number(match[1]);
    if (!audioByIndex.has(index)) audioByIndex.set(index, []);
    audioByIndex.get(index).push(file);
  }
  for (const files of audioByIndex.values()) {
    files.sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }
  const table = document.createElement("table");
  table.className = "calendar-preview-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of [
    "시작",
    "길이",
    "편성명",
    "프로그램 ID",
    "I-LKFS",
    "오디오",
  ]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  schedule.items.forEach((item, index) => {
    const row = document.createElement("tr");
    const startTime = item.StartTime.slice(11);
    const reportRow = reportRows.get(
      `${startTime}|${item.ProgramID || ""}`,
    );
    const values = [
      startTime,
      formatDuration(item.Duration),
      item.ProgramItemName || "—",
      item.ProgramID || "—",
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      cell.title = value;
      row.append(cell);
    }
    const loudnessCell = document.createElement("td");
    loudnessCell.className = "calendar-ilkfs";
    if (Number.isFinite(reportRow?.ilkfs)) {
      loudnessCell.textContent = `${reportRow.ilkfs.toFixed(2)} LKFS`;
      loudnessCell.title = `원본 계산값: ${reportRow.ilkfs}`;
    } else {
      loudnessCell.textContent = report ? "계산값 없음" : "—";
      loudnessCell.classList.add("missing");
    }
    row.append(loudnessCell);

    const audioCell = document.createElement("td");
    audioCell.className = "calendar-audio-cell";
    const files = audioByIndex.get(index + 1) || [];
    files.forEach((file, partIndex) => {
      const url =
        `/api/program-audio/file?channelId=${encodeURIComponent(channelId)}` +
        `&date=${encodeURIComponent(date)}` +
        `&name=${encodeURIComponent(file.name)}`;
      const control = document.createElement("div");
      control.className = "calendar-audio-control";
      if (files.length > 1) {
        control.classList.add("multipart");
        const part = document.createElement("span");
        part.textContent = `${partIndex + 1}/${files.length}`;
        control.append(part);
      }
      const listen = document.createElement("button");
      listen.className = "calendar-audio-open";
      listen.type = "button";
      listen.textContent = files.length > 1
        ? `듣기 ${partIndex + 1}`
        : "듣기";
      listen.title = `${item.ProgramItemName || "편성 오디오"} 크게 열기`;
      listen.addEventListener("click", () => {
        openAudioPreview({
          url,
          fileName: file.name,
          title: item.ProgramItemName,
          date,
          startTime,
          duration: item.Duration,
          partLabel:
            files.length > 1 ? `${partIndex + 1}/${files.length}` : "",
        });
      });
      const download = document.createElement("a");
      download.className = "calendar-audio-download";
      download.textContent = "↓";
      download.title = "WAV 다운로드";
      download.href = url;
      download.download = file.name;
      control.append(listen, download);
      audioCell.append(control);
    });
    if (!files.length) audioCell.textContent = "—";
    row.append(audioCell);
    body.append(row);
  });
  table.append(head, body);
  container.className = "calendar-preview-table-wrap";
  container.replaceChildren(table);
}

function renderCalendarReportPreview(day) {
  const container = $("#calendar-report-preview");
  container.className = "calendar-report-content";
  container.replaceChildren();

  const reportBlock = document.createElement("div");
  reportBlock.className = `calendar-artifact ${day.hasReport ? "ready" : ""}`;
  const reportLabel = document.createElement("span");
  reportLabel.textContent = "LOUDNESS REPORT";
  const reportName = document.createElement("strong");
  reportName.textContent = day.reportName || "생성된 리포트 없음";
  reportBlock.append(reportLabel, reportName);
  if (day.reportName) {
    const download = document.createElement("a");
    download.className = "text-button";
    download.textContent = "XLSX 다운로드";
    download.href =
      `/api/reports/${encodeURIComponent(day.reportName)}/download`;
    reportBlock.append(download);
  }

  const audioBlock = document.createElement("div");
  const audioWorking = ["queued", "running"].includes(day.audioJobState);
  audioBlock.className =
    `calendar-artifact ${day.hasAudio ? "ready" : ""}` +
    (audioWorking ? " working" : "");
  const audioLabel = document.createElement("span");
  audioLabel.textContent = "PROGRAMME AUDIO";
  const audioState = document.createElement("strong");
  audioState.textContent =
    day.audioJobState === "running"
      ? "백그라운드 생성 중"
      : day.audioJobState === "queued"
        ? "작업 대기 중"
        : day.audioJobState === "failed"
          ? "생성 실패"
          : day.audioJobState === "warning"
            ? "완료 · 일부 누락"
            : day.hasAudio
              ? "청취 가능"
              : "생성된 오디오 없음";
  audioBlock.append(audioLabel, audioState);

  const action = document.createElement("button");
  action.className = "button primary";
  action.textContent = day.hasReport ? "리포트 다시 계산" : "리포트 생성";
  action.disabled = !day.hasSchedule;
  action.addEventListener("click", () =>
    $("#calendar-create-report").click(),
  );
  container.append(reportBlock, audioBlock, action);
}

function renderRecorders(recorders) {
  const active = recorders.filter((recorder) => recorder.state === "recording").length;
  const summary = $("#recorder-summary");
  summary.textContent = `${active}/${recorders.length} RECORDING`;
  summary.className = `badge ${
    active === recorders.length ? "good" : active > 0 ? "neutral" : "danger"
  }`;

  const rows = recorders.map((recorder) => {
    const row = document.createElement("div");
    row.className = "recorder-row";

    const identity = document.createElement("div");
    identity.className = "recorder-identity";
    const title = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = recorder.name;
    const badge = document.createElement("span");
    const labels = {
      recording: "RECORDING",
      idle: "IDLE",
      unavailable: "ERROR",
    };
    badge.textContent = labels[recorder.state] || recorder.state;
    badge.className = `badge ${
      recorder.state === "recording"
        ? "good"
        : recorder.state === "unavailable"
          ? "danger"
          : "neutral"
    }`;
    title.append(name, badge);
    const path = document.createElement("small");
    path.textContent = recorder.recordingsDirectory;
    path.title = recorder.recordingsDirectory;
    identity.append(title, path);

    const files = document.createElement("div");
    files.className = "recorder-files";
    const wav = document.createElement("small");
    wav.textContent = `WAV  ${recorder.latestWav?.name || "—"}`;
    wav.title = recorder.latestWav?.name || "";
    const csv = document.createElement("small");
    csv.textContent =
      recorder.state === "unavailable"
        ? recorder.error
        : `M-LKFS  ${recorder.latestMlkfs?.name || "—"}`;
    csv.title =
      recorder.state === "unavailable"
        ? recorder.error
        : recorder.latestMlkfs?.name || "";
    files.append(wav, csv);
    row.append(identity, files);
    return row;
  });
  $("#recorder-list").replaceChildren(...rows);
}

function renderFileRows(container, files) {
  if (!files.length) {
    container.className = "file-list empty";
    container.textContent = "리포트가 없습니다.";
    return;
  }
  container.className = "file-list";
  container.replaceChildren(
    ...files.map((file) => {
      const row = document.createElement("div");
      row.className = "file-row";
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = file.name;
      const meta = document.createElement("small");
      meta.textContent = `${formatBytes(file.size)} · ${new Date(file.modifiedAt).toLocaleString("ko-KR")}`;
      text.append(name, meta);
      const link = document.createElement("a");
      link.className = "text-button";
      link.textContent = "다운로드";
      link.href = `/api/reports/${encodeURIComponent(file.name)}/download`;
      row.append(text, link);
      return row;
    }),
  );
}

async function loadSchedule() {
  const date = $("#schedule-date").value;
  const channelId = $("#schedule-channel").value;
  if (!channelId) return notify("리포트 채널을 선택하세요.", true);
  if (!date) return notify("방송일을 선택하세요.", true);
  try {
    const schedule = await api(
      `/api/schedule?channelId=${encodeURIComponent(channelId)}` +
        `&date=${encodeURIComponent(date)}`,
    );
    setSchedule(channelId, date, schedule);
    notify("저장된 편성표를 열었습니다.");
  } catch (error) {
    if (error.message.includes("없습니다")) {
      if (confirm("저장된 편성표가 없습니다. API에서 받아오시겠습니까?")) {
        return fetchSchedule(false);
      }
    }
    notify(error.message, true);
  }
}

async function fetchSchedule(requireConfirmation = true) {
  const date = $("#schedule-date").value;
  const channelId = $("#schedule-channel").value;
  if (!channelId) return notify("리포트 채널을 선택하세요.", true);
  if (!date) return notify("방송일을 선택하세요.", true);
  if (
    requireConfirmation &&
    !confirm("현재 저장된 수정사항을 버리고 API 편성표로 교체하시겠습니까?")
  ) {
    return;
  }
  try {
    const schedule = await api("/api/schedule/fetch", {
      method: "POST",
      body: JSON.stringify({ channelId, date }),
    });
    setSchedule(channelId, date, schedule);
    notify("API 편성표로 교체했습니다.");
  } catch (error) {
    notify(error.message, true);
  }
}

function setSchedule(channelId, date, schedule) {
  state.channelId = channelId;
  state.date = date;
  state.schedule = schedule;
  state.dirty = false;
  state.audioFiles = new Map();
  state.audioFilesSignature = `loading:${channelId}:${date}`;
  $("#schedule-summary").hidden = false;
  $("#save-schedule").disabled = true;
  $("#calculate-report").disabled = false;
  updateScheduleSummary();
  renderSchedule();
  void loadProgramAudio(channelId, date);
}

async function loadProgramAudio(channelId, date) {
  try {
    const files = await api(
      `/api/program-audio?channelId=${encodeURIComponent(channelId)}` +
        `&date=${encodeURIComponent(date)}`,
    );
    if (state.channelId !== channelId || state.date !== date) return;
    const signature = files
      .map((file) => `${file.name}:${file.size}:${file.modifiedAt}`)
      .sort()
      .join("|");
    if (signature === state.audioFilesSignature) return;
    const grouped = new Map();
    for (const file of files) {
      const match = /^(\d{3})_/.exec(file.name);
      if (!match) continue;
      const index = Number(match[1]);
      if (!grouped.has(index)) grouped.set(index, []);
      grouped.get(index).push(file);
    }
    for (const values of grouped.values()) {
      values.sort((left, right) => left.name.localeCompare(right.name, "ko"));
    }
    state.audioFiles = grouped;
    state.audioFilesSignature = signature;
    renderSchedule();
  } catch {
    state.audioFiles = new Map();
    state.audioFilesSignature = "";
  }
}

function updateScheduleSummary() {
  if (!state.schedule?.items?.length) return;
  const items = state.schedule.items;
  const first = items[0];
  const last = items.at(-1);
  const end = new Date(`${last.StartTime.replace(" ", "T")}+09:00`);
  end.setSeconds(end.getSeconds() + Number(last.Duration));
  const total = items.reduce((sum, item) => sum + Number(item.Duration), 0);
  $("#summary-count").textContent = `${items.length}개`;
  $("#summary-start").textContent = first.StartTime;
  $("#summary-end").textContent = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(end);
  $("#summary-duration").textContent = formatDuration(total);
  $("#dirty-state").textContent = state.dirty ? "저장 필요" : "저장됨";
  $("#dirty-state").className = `save-state ${state.dirty ? "dirty" : "saved"}`;
}

function markDirty() {
  state.dirty = true;
  state.audioFiles = new Map();
  state.audioFilesSignature = "";
  $("#save-schedule").disabled = false;
  updateScheduleSummary();
}

function renderSchedule() {
  const body = $("#schedule-rows");
  if (!state.schedule) return;
  const query = state.filter.toLocaleLowerCase("ko");
  const fragment = document.createDocumentFragment();
  state.schedule.items.forEach((item, index) => {
    if (
      query &&
      !`${item.ProgramItemName} ${item.ProgramID}`.toLocaleLowerCase("ko").includes(query)
    ) {
      return;
    }
    const row = document.createElement("tr");
    const number = document.createElement("td");
    number.textContent = item.EventIndex || index + 1;
    const startCell = document.createElement("td");
    const start = document.createElement("input");
    start.type = "datetime-local";
    start.step = "1";
    start.value = localInputValue(item.StartTime);
    start.addEventListener("change", () => {
      item.StartTime = apiTimeValue(start.value);
      markDirty();
    });
    startCell.append(start);
    const durationCell = document.createElement("td");
    const duration = document.createElement("input");
    duration.value = formatDuration(item.Duration);
    duration.addEventListener("change", () => {
      const parsed = parseDuration(duration.value);
      if (!parsed) {
        duration.setCustomValidity("HH:MM:SS 형식으로 입력하세요.");
        duration.reportValidity();
        duration.value = formatDuration(item.Duration);
        return;
      }
      duration.setCustomValidity("");
      item.Duration = String(parsed);
      duration.value = formatDuration(parsed);
      markDirty();
    });
    durationCell.append(duration);
    const titleCell = document.createElement("td");
    const title = document.createElement("input");
    title.value = item.ProgramItemName;
    title.addEventListener("input", () => {
      item.ProgramItemName = title.value;
      markDirty();
    });
    titleCell.append(title);
    const idCell = document.createElement("td");
    const id = document.createElement("input");
    id.value = item.ProgramID;
    id.addEventListener("input", () => {
      item.ProgramID = id.value;
      markDirty();
    });
    idCell.append(id);
    const actionCell = document.createElement("td");
    actionCell.className = "row-actions";
    const audioFiles = state.audioFiles.get(index + 1) || [];
    audioFiles.forEach((file, partIndex) => {
      const audio = document.createElement("a");
      audio.className = "row-audio";
      audio.textContent =
        audioFiles.length === 1 ? "▶" : `▶${partIndex + 1}`;
      audio.title =
        audioFiles.length === 1
          ? "편성 오디오 듣기"
          : `편성 오디오 ${partIndex + 1}/${audioFiles.length} 듣기`;
      audio.target = "_blank";
      audio.rel = "noopener";
      audio.href =
        `/api/program-audio/file?channelId=${encodeURIComponent(state.channelId)}` +
        `&date=${encodeURIComponent(state.date)}` +
        `&name=${encodeURIComponent(file.name)}`;
      actionCell.append(audio);
    });
    const remove = document.createElement("button");
    remove.className = "row-delete";
    remove.title = "편성 삭제";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      if (!confirm(`${item.ProgramItemName} 편성을 삭제하시겠습니까?`)) return;
      state.schedule.items.splice(index, 1);
      markDirty();
      renderSchedule();
    });
    actionCell.append(remove);
    row.append(number, startCell, durationCell, titleCell, idCell, actionCell);
    fragment.append(row);
  });
  body.replaceChildren(fragment);
  if (!body.children.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">검색 결과가 없습니다.</td></tr>';
  }
}

async function saveSchedule(showMessage = true) {
  if (!state.schedule || !state.date || !state.channelId) {
    throw new Error("열린 편성표가 없습니다.");
  }
  const schedule = await api("/api/schedule", {
    method: "PUT",
    body: JSON.stringify({
      channelId: state.channelId,
      date: state.date,
      schedule: state.schedule,
    }),
  });
  setSchedule(state.channelId, state.date, schedule);
  if (showMessage) notify("편성표를 저장했습니다.");
}

async function calculateReport() {
  try {
    if (state.dirty) await saveSchedule(false);
    const job = await api("/api/reports", {
      method: "POST",
      body: JSON.stringify({ channelId: state.channelId, date: state.date }),
    });
    showJob(job);
  } catch (error) {
    notify(error.message, true);
  }
}

function showJob(job) {
  clearInterval(state.jobTimer);
  $("#job-title").textContent =
    `${job.date} · ${job.channelName || "기본 채널"} 리포트 계산`;
  $("#job-dialog").showModal();
  updateJobDialog(job);
  state.jobTimer = setInterval(async () => {
    try {
      const current = await api(`/api/jobs/${job.id}`);
      updateJobDialog(current);
      if (!["queued", "running"].includes(current.state)) {
        clearInterval(state.jobTimer);
        loadDashboard();
        if (state.view === "calendar") void loadCalendar();
        if (
          state.channelId === current.channelId &&
          state.date === current.date
        ) {
          void loadProgramAudio(current.channelId, current.date);
        }
      }
    } catch (error) {
      clearInterval(state.jobTimer);
      notify(error.message, true);
    }
  }, 350);
}

function updateJobDialog(job) {
  const labels = {
    queued: "작업 대기 중",
    running: "M-LKFS 블록 계산 중",
    completed: "리포트 생성 완료 · 오디오는 백그라운드 처리",
    warning: "일부 편성 데이터 누락",
    failed: "리포트 생성 실패",
  };
  $("#job-state").className = `job-state ${job.state}`;
  $("#job-state").innerHTML = `<span></span>${labels[job.state] || job.state}`;
  $("#job-log").textContent = job.output || "작업을 시작하고 있습니다…";
  $("#job-log").scrollTop = $("#job-log").scrollHeight;
  const download = $("#download-job-report");
  download.hidden = !["completed", "warning"].includes(job.state);
  download.onclick = () => {
    location.href = `/api/reports/${encodeURIComponent(job.reportName)}/download`;
  };
}

async function loadReports() {
  try {
    const [files, audioJobs] = await Promise.all([
      api("/api/reports"),
      api("/api/audio-jobs"),
    ]);
    renderAudioJobs(audioJobs);
    const container = $("#report-list");
    if (!files.length) {
      container.className = "report-grid empty";
      container.textContent = "리포트가 없습니다.";
      return;
    }
    container.className = "report-grid";
    container.replaceChildren(
      ...files.map((file) => {
        const card = document.createElement("article");
        card.className = "report-card";
        const icon = document.createElement("div");
        icon.className = "file-icon";
        icon.textContent = "XL";
        const name = document.createElement("strong");
        name.textContent = file.name;
        const meta = document.createElement("small");
        meta.textContent = `${formatBytes(file.size)} · ${new Date(file.modifiedAt).toLocaleString("ko-KR")}`;
        const link = document.createElement("a");
        link.className = "button secondary";
        link.textContent = "다운로드";
        link.href = `/api/reports/${encodeURIComponent(file.name)}/download`;
        card.append(icon, name, meta, link);
        return card;
      }),
    );
  } catch (error) {
    notify(error.message, true);
  }
}

async function loadAudioJobs() {
  if (state.view !== "reports") return;
  try {
    renderAudioJobs(await api("/api/audio-jobs"));
  } catch (error) {
    notify(error.message, true);
  }
}

function renderAudioJobs(jobs) {
  const list = $("#audio-job-list");
  const log = $("#audio-job-log");
  const summary = $("#audio-job-summary");
  if (!jobs.length) {
    list.className = "audio-job-list empty";
    list.textContent = "백그라운드 오디오 작업이 없습니다.";
    log.textContent = "작업을 선택하면 실행 로그가 표시됩니다.";
    summary.textContent = "실행 기록이 없습니다.";
    return;
  }
  const active = jobs.filter((job) =>
    ["queued", "running"].includes(job.state),
  );
  summary.textContent = active.length
    ? `실행 중 ${active.filter((job) => job.state === "running").length} · 대기 ${active.filter((job) => job.state === "queued").length}`
    : "현재 실행 중인 작업이 없습니다.";
  if (
    !state.selectedAudioJobId ||
    !jobs.some((job) => job.id === state.selectedAudioJobId)
  ) {
    state.selectedAudioJobId =
      jobs.find((job) => job.state === "running")?.id || jobs[0].id;
  }
  const labels = {
    queued: "대기",
    running: "실행 중",
    completed: "완료",
    warning: "일부 누락",
    failed: "실패",
  };
  list.className = "audio-job-list";
  list.replaceChildren(
    ...jobs.map((job) => {
      const button = document.createElement("button");
      button.className =
        `audio-job-item ${job.state}` +
        (job.id === state.selectedAudioJobId ? " selected" : "");
      const title = document.createElement("strong");
      title.textContent = `${job.channelName} · ${job.date}`;
      const status = document.createElement("span");
      status.textContent = labels[job.state] || job.state;
      button.append(title, status);
      button.addEventListener("click", () => {
        state.selectedAudioJobId = job.id;
        renderAudioJobs(jobs);
      });
      return button;
    }),
  );
  const selected =
    jobs.find((job) => job.id === state.selectedAudioJobId) || jobs[0];
  log.textContent = selected.output || "아직 출력된 로그가 없습니다.";
  log.scrollTop = log.scrollHeight;
}

async function loadLogs() {
  try {
    if (!state.settings) state.settings = await api("/api/settings");
    const channelSelect = $("#log-channel");
    const previousChannel = channelSelect.value;
    channelSelect.replaceChildren(
      ...state.settings.channels.map((channel) => {
        const option = document.createElement("option");
        option.value = channel.id;
        option.textContent = channel.name;
        return option;
      }),
    );
    channelSelect.value = state.settings.channels.some(
      (channel) => channel.id === previousChannel,
    )
      ? previousChannel
      : state.settings.channels[0]?.id || "";
    await loadLogIndex();
  } catch (error) {
    $("#log-viewer-content").textContent = error.message;
    notify(error.message, true);
  }
}

async function loadLogIndex() {
  const channelId = $("#log-channel").value;
  if (!channelId) return;
  const previousDate = $("#log-date").value;
  const index = await api(
    `/api/logs/index?channelId=${encodeURIComponent(channelId)}`,
  );
  const dateSelect = $("#log-date");
  dateSelect.replaceChildren(
    ...index.dates.map((item) => {
      const option = document.createElement("option");
      option.value = item.date;
      const types = [
        item.recorder ? "REC" : "",
        item.report ? "REPORT" : "",
      ].filter(Boolean).join(" + ");
      option.textContent = `${item.date}${types ? ` · ${types}` : ""}`;
      option.dataset.recorder = String(item.recorder);
      option.dataset.report = String(item.report);
      return option;
    }),
  );
  dateSelect.value = index.dates.some((item) => item.date === previousDate)
    ? previousDate
    : index.dates[0]?.date || "";
  if (!dateSelect.value) {
    $("#log-viewer-content").textContent = "저장된 로그가 없습니다.";
    $("#log-viewer-meta").textContent = "로그 없음";
    return;
  }
  selectAvailableLogType();
  await loadLogContent();
}

function selectAvailableLogType() {
  const selected = $("#log-date").selectedOptions[0];
  const type = $("#log-type");
  if (selected?.dataset[type.value] !== "true") {
    type.value = selected?.dataset.recorder === "true" ? "recorder" : "report";
  }
}

async function loadLogContent() {
  const channelId = $("#log-channel").value;
  const date = $("#log-date").value;
  const type = $("#log-type").value;
  if (!channelId || !date) return;
  const content = $("#log-viewer-content");
  content.textContent = "로그를 불러오는 중입니다.";
  try {
    const value = await api(
      `/api/logs/content?channelId=${encodeURIComponent(channelId)}` +
      `&date=${encodeURIComponent(date)}&type=${encodeURIComponent(type)}`,
    );
    const label = type === "recorder" ? "레코더" : "리포트 · 편성 오디오";
    $("#log-viewer-title").textContent = `${value.channelName} · ${label}`;
    $("#log-viewer-meta").textContent =
      `${date} KST${value.truncated ? " · 마지막 500,000자 표시" : ""}`;
    content.textContent = value.content || "해당 날짜의 로그가 없습니다.";
    content.scrollTop = content.scrollHeight;
  } catch (error) {
    content.textContent = error.message;
    notify(error.message, true);
  }
}

async function loadSettings() {
  try {
    [state.settings, state.scheduler] = await Promise.all([
      api("/api/settings"),
      api("/api/scheduler"),
    ]);
    renderSettings();
  } catch (error) {
    notify(error.message, true);
  }
}

const retentionFields = [
  { key: "wavDays", selector: "#retention-wav", shortLabel: "WAV" },
  { key: "mlkfsDays", selector: "#retention-mlkfs", shortLabel: "M-LKFS" },
  {
    key: "programAudioDays",
    selector: "#retention-program-audio",
    shortLabel: "편성 오디오",
  },
  {
    key: "schedulesDays",
    selector: "#retention-schedules",
    shortLabel: "편성표",
  },
  {
    key: "reportsDays",
    selector: "#retention-reports",
    shortLabel: "리포트",
  },
  {
    key: "recorderLogsDays",
    selector: "#retention-recorder-logs",
    shortLabel: "레코더 로그",
  },
  {
    key: "reportLogsDays",
    selector: "#retention-report-logs",
    shortLabel: "리포트 로그",
  },
];

function ensureRetention(channel) {
  channel.retention ||= {};
  for (const { key } of retentionFields) {
    if (!Number.isFinite(Number(channel.retention[key]))) {
      channel.retention[key] = 0;
    }
  }
  return channel.retention;
}

function retentionSummary(channel) {
  const retention = ensureRetention(channel);
  return retentionFields
    .map(({ key, shortLabel }) => {
      const days = Number(retention[key]) || 0;
      return `${shortLabel} ${days === 0 ? "무기한" : `${days}일`}`;
    })
    .join(" · ");
}

function renderRetentionDialog() {
  const channel = state.settings?.channels.find(
    (item) => item.id === $("#retention-channel").value,
  );
  if (!channel) return;
  const retention = ensureRetention(channel);
  for (const { key, selector } of retentionFields) {
    $(selector).value = retention[key] ?? 0;
  }
}

function openRetentionDialog(channelId = "") {
  if (!state.settings) return;
  const select = $("#retention-channel");
  select.replaceChildren(
    ...state.settings.channels.map((channel) => {
      const option = document.createElement("option");
      option.value = channel.id;
      option.textContent = channel.name;
      return option;
    }),
  );
  select.value = state.settings.channels.some(
    (channel) => channel.id === channelId,
  )
    ? channelId
    : state.settings.channels[0].id;
  state.settings.maintenance ||= { webLogsDays: 0 };
  $("#retention-web-logs").value =
    state.settings.maintenance.webLogsDays ?? 0;
  renderRetentionDialog();
  $("#retention-dialog").showModal();
}

function renderSettings() {
  if (!state.settings) return;
  $("#schedule-api").value = state.settings.scheduleApi || "";
  $("#report-schedule-enabled").checked =
    state.settings.reportSchedule?.enabled ?? true;
  $("#report-schedule-time").value =
    state.settings.reportSchedule?.timeKst || "08:00";
  $("#retention-web-logs").value =
    state.settings.maintenance?.webLogsDays ?? 0;
  renderSchedulerStatus();
  renderCleanupStatus();
  const container = $("#channel-settings");
  const rows = state.settings.channels.map((channel) => {
    const row = document.createElement("div");
    row.className = "channel-setting-row";
    const main = document.createElement("div");
    main.className = "channel-setting-main";

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "채널 이름";
    const name = document.createElement("input");
    name.value = channel.name;
    name.maxLength = 80;
    name.addEventListener("input", () => {
      channel.name = name.value;
    });
    nameLabel.append(name);

    const pathLabel = document.createElement("label");
    pathLabel.textContent = "녹음 데이터 조회 경로";
    const path = document.createElement("input");
    path.value = channel.recordingsDirectory;
    path.placeholder = "/mnt/hdd/recordings/channel";
    path.spellcheck = false;
    path.addEventListener("input", () => {
      channel.recordingsDirectory = path.value;
    });
    pathLabel.append(path);

    const logLabel = document.createElement("label");
    logLabel.textContent = "레코더 로그 파일";
    const logName = document.createElement("input");
    logName.value = channel.recorderLogName || `recorder-${channel.id}.log`;
    logName.placeholder = "recorder-port2.log";
    logName.maxLength = 132;
    logName.spellcheck = false;
    logName.addEventListener("input", () => {
      channel.recorderLogName = logName.value;
    });
    logLabel.append(logName);

    const reportLabel = document.createElement("label");
    reportLabel.textContent = "리포트 대상";
    const reportBox = document.createElement("div");
    reportBox.className = "setting-check";
    const reportEnabled = document.createElement("input");
    reportEnabled.type = "checkbox";
    reportEnabled.checked = Boolean(channel.reportEnabled);
    const reportText = document.createElement("span");
    reportText.textContent = "계산 사용";
    reportBox.append(reportEnabled, reportText);
    reportLabel.append(reportBox);

    reportEnabled.addEventListener("change", () => {
      channel.reportEnabled = reportEnabled.checked;
    });

    const remove = document.createElement("button");
    remove.className = "channel-remove";
    remove.type = "button";
    remove.title = "채널 삭제";
    remove.textContent = "×";
    remove.disabled = state.settings.channels.length === 1;
    remove.addEventListener("click", () => {
      if (!confirm(`${channel.name} 채널을 설정에서 삭제하시겠습니까?`)) return;
      state.settings.channels = state.settings.channels.filter(
        (item) => item.id !== channel.id,
      );
      renderSettings();
    });

    main.append(nameLabel, pathLabel, logLabel, reportLabel, remove);

    const policy = document.createElement("div");
    policy.className = "channel-policy";
    const policyText = document.createElement("div");
    const policyTitle = document.createElement("strong");
    policyTitle.textContent = "파일 보관";
    const policySummary = document.createElement("small");
    policySummary.textContent = retentionSummary(channel);
    policyText.append(policyTitle, policySummary);
    const policyButton = document.createElement("button");
    policyButton.className = "button ghost";
    policyButton.type = "button";
    policyButton.textContent = "보관기간 설정";
    policyButton.addEventListener("click", () =>
      openRetentionDialog(channel.id),
    );
    policy.append(policyText, policyButton);

    row.append(main, policy);
    return row;
  });
  container.replaceChildren(...rows);
}

function renderSchedulerStatus() {
  const node = $("#scheduler-status");
  if (!state.scheduler?.lastAttemptDateKst) {
    node.textContent = "최근 자동 실행 기록이 없습니다.";
    return;
  }
  const labels = {
    running: "실행 중",
    completed: "완료",
    warning: "일부 데이터 누락",
    failed: "실패",
  };
  const finished = state.scheduler.finishedAt
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(new Date(state.scheduler.finishedAt))
    : "진행 중";
  node.textContent =
    `최근 실행: ${state.scheduler.broadcastDate} 방송분 · ` +
    `${labels[state.scheduler.status] || state.scheduler.status} · ${finished}`;
}

function renderCleanupStatus() {
  const node = $("#cleanup-status");
  const cleanup = state.scheduler?.cleanupResult;
  if (!state.scheduler?.lastCleanupAt || !cleanup) {
    node.textContent = "최근 자동 정리 기록이 없습니다.";
    return;
  }
  const executed = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(state.scheduler.lastCleanupAt));
  const deletedBytes =
    Number(cleanup.recordingWav?.bytes || cleanup.recordings?.bytes || 0) +
    Number(cleanup.mlkfs?.bytes || 0) +
    Number(cleanup.schedules?.bytes || 0) +
    Number(cleanup.reports?.bytes || 0) +
    Number(cleanup.reportLogs?.bytes || 0) +
    Number(cleanup.operationalLogs?.bytes || 0);
  node.textContent =
    `최근 정리: ${executed} · ` +
    `WAV ${cleanup.recordingWav?.files || cleanup.recordings?.files || 0}개 · ` +
    `M-LKFS ${cleanup.mlkfs?.files || 0}개 · ` +
    `편성 오디오 ${cleanup.programAudio?.directories || 0}일 · ` +
    `편성표 ${cleanup.schedules?.files || 0}개 · ` +
    `리포트 ${cleanup.reports?.files || 0}개 · ` +
    `리포트 로그 ${cleanup.reportLogs?.files || 0}개 · ` +
    `로그 압축 ${cleanup.operationalLogs?.rotatedFiles || 0}개 · ` +
    `확인된 용량 ${formatBytes(deletedBytes)} · ` +
    `오류 ${cleanup.errors?.length || 0}개`;
}

function addChannel() {
  if (!state.settings) return;
  if (state.settings.channels.length >= 16) {
    return notify("채널은 최대 16개까지 등록할 수 있습니다.", true);
  }
  const id = `channel_${Date.now().toString(36)}`;
  state.settings.channels.push({
    id,
    name: `채널 ${state.settings.channels.length + 1}`,
    recordingsDirectory: "/mnt/hdd/recordings/",
    recorderLogName: `recorder-${id}.log`,
    reportEnabled: false,
    retention: {
      wavDays: 0,
      mlkfsDays: 0,
      programAudioDays: 0,
      schedulesDays: 0,
      reportsDays: 0,
      recorderLogsDays: 0,
      reportLogsDays: 0,
    },
  });
  renderSettings();
  $("#channel-settings .channel-setting-row:last-child input")?.focus();
}

async function saveSettings() {
  if (!state.settings) return;
  state.settings.scheduleApi = $("#schedule-api").value.trim();
  state.settings.reportSchedule = {
    enabled: $("#report-schedule-enabled").checked,
    timeKst: $("#report-schedule-time").value || "08:00",
  };
  state.settings.maintenance = {
    webLogsDays: Number($("#retention-web-logs").value || 0),
  };
  try {
    state.settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(state.settings),
    });
    renderSettings();
    await loadDashboard();
    notify("채널 설정을 저장했습니다.");
  } catch (error) {
    notify(error.message, true);
  }
}

$$("[data-view]").forEach((button) =>
  button.addEventListener("click", () => switchView(button.dataset.view)),
);
$$("[data-view-link]").forEach((button) =>
  button.addEventListener("click", () => switchView(button.dataset.viewLink)),
);
$("#refresh-view").addEventListener("click", () => switchView(state.view));
$("#log-channel").addEventListener("change", () => void loadLogIndex());
$("#log-date").addEventListener("change", () => {
  selectAvailableLogType();
  void loadLogContent();
});
$("#log-type").addEventListener("change", () => void loadLogContent());
$("#load-log").addEventListener("click", () => void loadLogContent());
$("#theme-toggle").addEventListener("click", () => {
  applyTheme(
    document.documentElement.dataset.theme === "light" ? "dark" : "light",
  );
});
$("#open-retention-settings").addEventListener("click", () =>
  openRetentionDialog(),
);
$("#retention-channel").addEventListener("change", renderRetentionDialog);
for (const { key, selector } of retentionFields) {
  $(selector).addEventListener("input", () => {
    const channel = state.settings?.channels.find(
      (item) => item.id === $("#retention-channel").value,
    );
    if (!channel) return;
    ensureRetention(channel)[key] = Number($(selector).value || 0);
  });
}
$("#retention-web-logs").addEventListener("input", () => {
  if (!state.settings) return;
  state.settings.maintenance ||= { webLogsDays: 0 };
  state.settings.maintenance.webLogsDays = Number(
    $("#retention-web-logs").value || 0,
  );
});
$("#close-retention").addEventListener("click", () =>
  $("#retention-dialog").close(),
);
$("#confirm-retention").addEventListener("click", () =>
  $("#retention-dialog").close(),
);
$("#retention-dialog").addEventListener("close", renderSettings);
$("#open-schedule").addEventListener("click", () => {
  $("#schedule-channel").value = $("#dashboard-channel").value;
  $("#schedule-date").value = $("#dashboard-date").value;
  switchView("schedule");
  loadSchedule();
});
$("#calendar-channel").addEventListener("change", () => {
  state.calendarDate = "";
  state.calendarData = null;
  void loadCalendar();
});
$("#calendar-prev").addEventListener("click", () => {
  state.calendarMonth = shiftMonth(
    state.calendarMonth || todayKst().slice(0, 7),
    -1,
  );
  state.calendarDate = "";
  void loadCalendar();
});
$("#calendar-next").addEventListener("click", () => {
  state.calendarMonth = shiftMonth(
    state.calendarMonth || todayKst().slice(0, 7),
    1,
  );
  state.calendarDate = "";
  void loadCalendar();
});
$("#calendar-today").addEventListener("click", () => {
  state.calendarMonth = todayKst().slice(0, 7);
  state.calendarDate = todayKst();
  void loadCalendar();
});
$("#calendar-download-archive").addEventListener("click", () => {
  const channelId = $("#calendar-channel").value;
  const from = $("#calendar-archive-from").value;
  const to = $("#calendar-archive-to").value;
  if (!channelId || !from || !to) {
    return notify("채널과 다운로드 기간을 모두 선택하세요.", true);
  }
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  const days = Math.floor((toTime - fromTime) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1) {
    return notify("종료일은 시작일보다 빠를 수 없습니다.", true);
  }
  if (days > 366) {
    return notify("한 번에 최대 366일까지 다운로드할 수 있습니다.", true);
  }
  if (to > yesterdayKst()) {
    return notify("종료일은 서울 기준 전일까지만 선택할 수 있습니다.", true);
  }
  const link = document.createElement("a");
  link.href =
    `/api/archive/download?channelId=${encodeURIComponent(channelId)}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  document.body.append(link);
  link.click();
  link.remove();
  notify(
    `${days}일치 ZIP을 준비하고 있습니다. 파일이 크면 다운로드 시작까지 시간이 걸릴 수 있습니다.`,
  );
});
$("#calendar-open-schedule").addEventListener("click", () => {
  if (!state.calendarDate || !state.calendarData) return;
  $("#schedule-channel").value = state.calendarData.channelId;
  $("#schedule-date").value = state.calendarDate;
  switchView("schedule");
  void loadSchedule();
});
$("#calendar-detail-open-schedule").addEventListener("click", () => {
  $("#calendar-open-schedule").click();
});
$("#calendar-fetch-schedule").addEventListener("click", async () => {
  if (!state.calendarDate || !state.calendarData) return;
  try {
    await api("/api/schedule/fetch", {
      method: "POST",
      body: JSON.stringify({
        channelId: state.calendarData.channelId,
        date: state.calendarDate,
      }),
    });
    notify("API 편성표를 저장했습니다.");
    await loadCalendar();
  } catch (error) {
    notify(error.message, true);
  }
});
$("#calendar-create-report").addEventListener("click", async () => {
  if (!state.calendarDate || !state.calendarData) return;
  try {
    const job = await api("/api/reports", {
      method: "POST",
      body: JSON.stringify({
        channelId: state.calendarData.channelId,
        date: state.calendarDate,
      }),
    });
    showJob(job);
  } catch (error) {
    notify(error.message, true);
  }
});
$("#load-schedule").addEventListener("click", loadSchedule);
$("#fetch-schedule").addEventListener("click", () => fetchSchedule(true));
$("#save-schedule").addEventListener("click", () =>
  saveSchedule().catch((error) => notify(error.message, true)),
);
$("#calculate-report").addEventListener("click", calculateReport);
$("#schedule-filter").addEventListener("input", (event) => {
  state.filter = event.target.value;
  renderSchedule();
});
$("#audio-back-10").addEventListener("click", () => {
  const player = $("#audio-preview-player");
  player.currentTime = Math.max(0, player.currentTime - 10);
});
$("#audio-forward-10").addEventListener("click", () => {
  const player = $("#audio-preview-player");
  const target = player.currentTime + 10;
  player.currentTime = Number.isFinite(player.duration)
    ? Math.min(player.duration, target)
    : target;
});
$("#audio-playback-rate").addEventListener("change", () => {
  $("#audio-preview-player").playbackRate =
    Number($("#audio-playback-rate").value) || 1;
});
$("#close-audio-preview").addEventListener("click", () =>
  $("#audio-preview-dialog").close(),
);
$("#audio-preview-dialog").addEventListener("close", () => {
  const player = $("#audio-preview-player");
  player.pause();
  player.removeAttribute("src");
  player.load();
});
$("#close-job").addEventListener("click", () => $("#job-dialog").close());
$("#add-channel").addEventListener("click", addChannel);
$("#save-settings").addEventListener("click", saveSettings);
$("#schedule-channel").addEventListener("change", () => {
  state.schedule = null;
  state.channelId = "";
  state.dirty = false;
  $("#schedule-summary").hidden = true;
  $("#save-schedule").disabled = true;
  $("#calculate-report").disabled = true;
  $("#schedule-rows").innerHTML =
    '<tr class="empty-row"><td colspan="6">채널과 방송일을 선택하고 편성표를 여세요.</td></tr>';
});

const defaultDate = yesterdayKst();
$("#dashboard-date").value = defaultDate;
$("#schedule-date").value = defaultDate;
$("#calendar-archive-to").value = defaultDate;
$("#calendar-archive-from").value = shiftDate(defaultDate, -89);
updateArchiveDateLimits();
loadDashboard();
setInterval(loadDashboard, 15_000);
