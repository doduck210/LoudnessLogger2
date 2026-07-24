const state = {
  view: "dashboard",
  schedule: null,
  date: "",
  dirty: false,
  filter: "",
  jobTimer: null,
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
  const titles = {
    dashboard: "운영 대시보드",
    schedule: "편성표 관리",
    reports: "Loudness 리포트",
  };
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}-view`));
  $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  $("#page-title").textContent = titles[view];
  if (view === "dashboard") loadDashboard();
  if (view === "reports") loadReports();
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    $("#server-time").textContent = data.serverTimeKst;
    const recording = data.recorder.state === "recording";
    $("#recorder-badge").textContent = recording ? "RECORDING" : "IDLE";
    $("#recorder-badge").className = `badge ${recording ? "good" : "neutral"}`;
    $("#recorder-title").textContent = recording ? "오디오 입력 정상" : "최근 기록 없음";
    $(".signal-bars").style.opacity = recording ? "1" : ".25";
    $("#latest-wav").textContent = data.recorder.latestWav?.name || "—";
    $("#latest-csv").textContent = data.recorder.latestMlkfs?.name || "—";
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
  if (!date) return notify("방송일을 선택하세요.", true);
  try {
    const schedule = await api(`/api/schedule?date=${encodeURIComponent(date)}`);
    setSchedule(date, schedule);
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
      body: JSON.stringify({ date }),
    });
    setSchedule(date, schedule);
    notify("API 편성표로 교체했습니다.");
  } catch (error) {
    notify(error.message, true);
  }
}

function setSchedule(date, schedule) {
  state.date = date;
  state.schedule = schedule;
  state.dirty = false;
  $("#schedule-summary").hidden = false;
  $("#save-schedule").disabled = true;
  $("#calculate-report").disabled = false;
  updateScheduleSummary();
  renderSchedule();
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
  if (!state.schedule || !state.date) throw new Error("열린 편성표가 없습니다.");
  const schedule = await api("/api/schedule", {
    method: "PUT",
    body: JSON.stringify({ date: state.date, schedule: state.schedule }),
  });
  setSchedule(state.date, schedule);
  if (showMessage) notify("편성표를 저장했습니다.");
}

async function calculateReport() {
  try {
    if (state.dirty) await saveSchedule(false);
    const job = await api("/api/reports", {
      method: "POST",
      body: JSON.stringify({ date: state.date }),
    });
    showJob(job);
  } catch (error) {
    notify(error.message, true);
  }
}

function showJob(job) {
  clearInterval(state.jobTimer);
  $("#job-title").textContent = `${job.date} 리포트 계산`;
  $("#job-dialog").showModal();
  updateJobDialog(job);
  state.jobTimer = setInterval(async () => {
    try {
      const current = await api(`/api/jobs/${job.id}`);
      updateJobDialog(current);
      if (!["queued", "running"].includes(current.state)) {
        clearInterval(state.jobTimer);
        loadDashboard();
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
    completed: "리포트 생성 완료",
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
    const files = await api("/api/reports");
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

$$("[data-view]").forEach((button) =>
  button.addEventListener("click", () => switchView(button.dataset.view)),
);
$$("[data-view-link]").forEach((button) =>
  button.addEventListener("click", () => switchView(button.dataset.viewLink)),
);
$("#refresh-view").addEventListener("click", () => switchView(state.view));
$("#open-schedule").addEventListener("click", () => {
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

const defaultDate = yesterdayKst();
$("#dashboard-date").value = defaultDate;
$("#schedule-date").value = defaultDate;
loadDashboard();
setInterval(loadDashboard, 15_000);
