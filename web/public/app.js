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
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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
  node.style.color = isError ? "#f5c5c8" : "#b8f1dd";
  node.style.background = isError ? "#4b2026" : "#143a31";
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (node.hidden = true), 5000);
}

function switchView(view) {
  state.view = view;
  clearInterval(state.audioJobTimer);
  clearInterval(state.programAudioTimer);
  state.audioJobTimer = null;
  state.programAudioTimer = null;
  const titles = {
    dashboard: "운영 대시보드",
    schedule: "편성표 관리",
    reports: "Loudness 리포트",
    settings: "시스템 설정",
  };
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}-view`));
  $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  $("#page-title").textContent = titles[view];
  if (view === "dashboard") loadDashboard();
  if (view === "reports") {
    loadReports();
    state.audioJobTimer = setInterval(loadAudioJobs, 1_000);
  }
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
  for (const selector of ["#dashboard-channel", "#schedule-channel"]) {
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

function renderSettings() {
  if (!state.settings) return;
  $("#schedule-api").value = state.settings.scheduleApi || "";
  $("#report-schedule-enabled").checked =
    state.settings.reportSchedule?.enabled ?? true;
  $("#report-schedule-time").value =
    state.settings.reportSchedule?.timeKst || "08:00";
  renderSchedulerStatus();
  const container = $("#channel-settings");
  const rows = state.settings.channels.map((channel) => {
    const row = document.createElement("div");
    row.className = "channel-setting-row";

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

    row.append(nameLabel, pathLabel, reportLabel, remove);
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
    reportEnabled: false,
  });
  renderSettings();
  const inputs = $$("#channel-settings input");
  inputs.at(-3)?.focus();
}

async function saveSettings() {
  if (!state.settings) return;
  state.settings.scheduleApi = $("#schedule-api").value.trim();
  state.settings.reportSchedule = {
    enabled: $("#report-schedule-enabled").checked,
    timeKst: $("#report-schedule-time").value || "08:00",
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
$("#open-schedule").addEventListener("click", () => {
  $("#schedule-channel").value = $("#dashboard-channel").value;
  $("#schedule-date").value = $("#dashboard-date").value;
  switchView("schedule");
  loadSchedule();
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
loadDashboard();
setInterval(loadDashboard, 15_000);
