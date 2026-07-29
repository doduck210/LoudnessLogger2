import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(webDirectory, "..");
const publicDirectory = join(webDirectory, "public");

// 웹 서버 설정: 운영 환경이 바뀌면 이 구역만 수정한다.
const serverSettings = Object.freeze({
  host: "0.0.0.0",
  port: 8080,
  schedulesDirectory: "/mnt/hdd/schedules",
  reportsDirectory: "/mnt/hdd/reports",
  programAudioDirectory: "/mnt/hdd/reports/program_audio",
  reportExecutable: join(projectDirectory, "loudness_report"),
  scheduleApi: "http://10.110.21.31/cms/api/frmtn/dailyInfo.json",
  runtimeSettingsFile: join(webDirectory, "settings.json"),
  schedulerStateFile: join(webDirectory, "scheduler-state.json"),
});

const config = Object.freeze({
  host: serverSettings.host,
  port: parsePort(serverSettings.port),
  schedulesDirectory: resolve(serverSettings.schedulesDirectory),
  reportsDirectory: resolve(serverSettings.reportsDirectory),
  programAudioDirectory: resolve(serverSettings.programAudioDirectory),
  reportExecutable: resolve(serverSettings.reportExecutable),
  runtimeSettingsFile: resolve(serverSettings.runtimeSettingsFile),
  schedulerStateFile: resolve(serverSettings.schedulerStateFile),
});

const defaultRuntimeSettings = Object.freeze({
  scheduleApi: serverSettings.scheduleApi,
  reportSchedule: {
    enabled: true,
    timeKst: "08:00",
  },
  channels: [
    {
      id: "decklink2",
      name: "DeckLink 2",
      recordingsDirectory: "/mnt/hdd/recordings/decklink2",
      reportEnabled: true,
    },
    {
      id: "decklink3",
      name: "DeckLink 3",
      recordingsDirectory: "/mnt/hdd/recordings/decklink3",
      reportEnabled: true,
    },
    {
      id: "decklink4",
      name: "DeckLink 4",
      recordingsDirectory: "/mnt/hdd/recordings/decklink4",
      reportEnabled: false,
    },
  ],
});

const jobs = new Map();
const audioJobs = new Map();
const audioQueue = [];
let audioWorkerBusy = false;
const maxRequestBytes = 8 * 1024 * 1024;
const maxJobLogCharacters = 200_000;

await Promise.all([
  mkdir(config.schedulesDirectory, { recursive: true }),
  mkdir(config.reportsDirectory, { recursive: true }),
  mkdir(config.programAudioDirectory, { recursive: true }),
]);
let runtimeSettings = await loadRuntimeSettings();
let schedulerState = await loadSchedulerState();
let schedulerBusy = false;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid web server port: ${value}`);
  }
  return port;
}

function validateRuntimeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "설정 객체가 필요합니다.");
  }
  const scheduleApi = String(
    value.scheduleApi || serverSettings.scheduleApi,
  ).trim();
  let parsedScheduleApi;
  try {
    parsedScheduleApi = new URL(scheduleApi);
  } catch {
    throw httpError(400, "편성표 API 주소가 올바르지 않습니다.");
  }
  if (!["http:", "https:"].includes(parsedScheduleApi.protocol)) {
    throw httpError(400, "편성표 API는 http 또는 https 주소여야 합니다.");
  }
  const rawReportSchedule = value.reportSchedule || {};
  const reportSchedule = {
    enabled:
      typeof rawReportSchedule.enabled === "boolean"
        ? rawReportSchedule.enabled
        : true,
    timeKst: String(rawReportSchedule.timeKst || "08:00").trim(),
  };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reportSchedule.timeKst)) {
    throw httpError(400, "자동 리포트 실행 시각이 올바르지 않습니다.");
  }
  if (
    !Array.isArray(value.channels) ||
    value.channels.length < 1 ||
    value.channels.length > 16
  ) {
    throw httpError(400, "채널은 1개 이상 16개 이하로 등록해야 합니다.");
  }
  const ids = new Set();
  const fileNames = new Set();
  const legacyReportChannelId = String(value.reportChannelId || "").trim();
  const channels = value.channels.map((channel, index) => {
    const id = String(channel?.id || "").trim();
    const name = String(channel?.name || "").trim();
    const recordingsDirectory = String(
      channel?.recordingsDirectory || "",
    ).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw httpError(400, `${index + 1}번 채널 ID가 올바르지 않습니다.`);
    }
    if (ids.has(id)) {
      throw httpError(400, `중복된 채널 ID입니다: ${id}`);
    }
    ids.add(id);
    if (!name || name.length > 80) {
      throw httpError(400, `${index + 1}번 채널 이름이 올바르지 않습니다.`);
    }
    const fileName = channelFileName({ name });
    const fileNameKey = fileName.toLocaleLowerCase("en-US");
    if (!fileName || fileNames.has(fileNameKey)) {
      throw httpError(
        400,
        `${name}의 파일명이 비어 있거나 다른 채널 이름과 중복됩니다.`,
      );
    }
    fileNames.add(fileNameKey);
    if (!isAbsolute(recordingsDirectory)) {
      throw httpError(400, `${name}의 녹음 경로는 절대경로여야 합니다.`);
    }
    const reportEnabled =
      typeof channel.reportEnabled === "boolean"
        ? channel.reportEnabled
        : id === legacyReportChannelId;
    return {
      id,
      name,
      recordingsDirectory: resolve(recordingsDirectory),
      reportEnabled,
    };
  });
  if (!channels.some((channel) => channel.reportEnabled)) {
    throw httpError(400, "리포트 대상 채널을 하나 이상 선택해야 합니다.");
  }
  return {
    scheduleApi: parsedScheduleApi.toString(),
    reportSchedule,
    channels,
  };
}

async function verifyChannelDirectories(settings) {
  for (const channel of settings.channels) {
    try {
      const info = await stat(channel.recordingsDirectory);
      if (!info.isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw httpError(
        400,
        `${channel.name} 녹음 경로를 열 수 없습니다: ${channel.recordingsDirectory}`,
      );
    }
  }
}

async function loadRuntimeSettings() {
  try {
    const value = JSON.parse(await readFile(config.runtimeSettingsFile, "utf8"));
    return validateRuntimeSettings(value);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const defaults = validateRuntimeSettings(
      JSON.parse(JSON.stringify(defaultRuntimeSettings)),
    );
    await atomicWriteJson(config.runtimeSettingsFile, defaults);
    return defaults;
  }
}

async function saveRuntimeSettings(value) {
  const settings = validateRuntimeSettings(value);
  await verifyChannelDirectories(settings);
  await atomicWriteJson(config.runtimeSettingsFile, settings);
  runtimeSettings = settings;
  return settings;
}

async function loadSchedulerState() {
  try {
    const value = JSON.parse(await readFile(config.schedulerStateFile, "utf8"));
    return {
      lastAttemptDateKst:
        typeof value.lastAttemptDateKst === "string"
          ? value.lastAttemptDateKst
          : null,
      broadcastDate:
        typeof value.broadcastDate === "string" ? value.broadcastDate : null,
      status: typeof value.status === "string" ? value.status : "idle",
      startedAt:
        typeof value.startedAt === "string" ? value.startedAt : null,
      finishedAt:
        typeof value.finishedAt === "string" ? value.finishedAt : null,
      results: Array.isArray(value.results) ? value.results : [],
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`자동 리포트 상태 파일을 읽지 못했습니다: ${error.message}`);
    }
    return {
      lastAttemptDateKst: null,
      broadcastDate: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      results: [],
    };
  }
}

async function saveSchedulerState() {
  await atomicWriteJson(config.schedulerStateFile, schedulerState);
}

function requireChannel(channelId, reportOnly = false) {
  const channel = runtimeSettings.channels.find(
    (candidate) => candidate.id === String(channelId || ""),
  );
  if (!channel) {
    throw httpError(400, "채널을 선택해야 합니다.");
  }
  if (reportOnly && !channel.reportEnabled) {
    throw httpError(400, `${channel.name}은 리포트 대상 채널이 아닙니다.`);
  }
  return channel;
}

function channelFileName(channel) {
  return channel.name
    .normalize("NFKC")
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/[.\s]+$/g, "");
}

function schedulePath(channel, date) {
  return join(
    config.schedulesDirectory,
    `${channelFileName(channel)}_Schedule_${date}.json`,
  );
}

function reportPath(channel, date) {
  return join(
    config.reportsDirectory,
    `${channelFileName(channel)}_Loudness_Report_${date}.xlsx`,
  );
}

function programAudioPath(channel, date) {
  return join(config.programAudioDirectory, channelFileName(channel), date);
}

function requireDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, "날짜는 YYYY-MM-DD 형식이어야 합니다.");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw httpError(400, "유효하지 않은 날짜입니다.");
  }
  return value;
}

function validateSchedule(value, date) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "편성표 JSON 객체가 필요합니다.");
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw httpError(400, "편성 항목이 없습니다.");
  }
  let previousStart = -Infinity;
  for (const [index, item] of value.items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw httpError(400, `${index + 1}번 편성이 올바르지 않습니다.`);
    }
    if (
      typeof item.StartTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(item.StartTime)
    ) {
      throw httpError(400, `${index + 1}번 편성의 시작시각이 올바르지 않습니다.`);
    }
    const start = Date.parse(`${item.StartTime.replace(" ", "T")}+09:00`);
    if (!Number.isFinite(start)) {
      throw httpError(400, `${index + 1}번 편성의 시작시각이 유효하지 않습니다.`);
    }
    if (start < previousStart) {
      throw httpError(400, "편성 시작시각은 순서대로 정렬되어야 합니다.");
    }
    previousStart = start;
    if (!/^[1-9]\d*$/.test(String(item.Duration))) {
      throw httpError(400, `${index + 1}번 편성의 길이는 1초 이상이어야 합니다.`);
    }
    for (const field of ["ProgramItemName", "ProgramID"]) {
      if (typeof item[field] !== "string") {
        throw httpError(400, `${index + 1}번 편성의 ${field}가 문자열이 아닙니다.`);
      }
    }
  }
  value.date = date;
  return value;
}

async function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporaryPath, data, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

async function readSchedule(channel, date) {
  try {
    const text = await readFile(schedulePath(channel, date), "utf8");
    return validateSchedule(JSON.parse(text), date);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw httpError(404, "저장된 편성표가 없습니다.");
    }
    if (error instanceof SyntaxError) {
      throw httpError(500, "저장된 편성표 JSON을 해석할 수 없습니다.");
    }
    throw error;
  }
}

async function fetchSchedule(channel, date) {
  const url = new URL(runtimeSettings.scheduleApi);
  url.searchParams.set("date", date);
  url.searchParams.set("UHDSchedule", "False");
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw httpError(502, `편성표 API 응답 오류: HTTP ${response.status}`);
  }
  let value;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw httpError(502, "편성표 API가 올바른 JSON을 반환하지 않았습니다.");
  }
  if (String(value.ResultCode) !== "1") {
    throw httpError(
      502,
      `편성표 API 오류: ${value.result_msg || value.ResultCode || "unknown"}`,
    );
  }
  validateSchedule(value, date);
  value.channelId = channel.id;
  value.channelName = channel.name;
  await atomicWriteJson(schedulePath(channel, date), value);
  return value;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw httpError(413, "요청 데이터가 너무 큽니다.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "올바른 JSON 요청이 아닙니다.");
  }
}

async function directoryFiles(directory, predicate = () => true) {
  try {
    const names = await readdir(directory);
    const rows = await Promise.all(
      names.filter(predicate).map(async (name) => {
        const info = await stat(join(directory, name));
        return {
          name,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
    );
    return rows.sort((left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function channelStatus(channel) {
  try {
    const recordings = await directoryFiles(
      channel.recordingsDirectory,
      (name) => name.endsWith(".wav") || name.endsWith("_mlkfs.csv"),
    );
    const latestWav = recordings.find((file) => file.name.endsWith(".wav"));
    const latestCsv = recordings.find((file) =>
      file.name.endsWith("_mlkfs.csv"),
    );
    const lastWrite = latestWav
      ? Date.now() - Date.parse(latestWav.modifiedAt)
      : Infinity;
    return {
      ...channel,
      state: lastWrite < 20_000 ? "recording" : "idle",
      latestWav: latestWav || null,
      latestMlkfs: latestCsv || null,
      recordingFiles: recordings.length,
      error: null,
    };
  } catch (error) {
    return {
      ...channel,
      state: "unavailable",
      latestWav: null,
      latestMlkfs: null,
      recordingFiles: 0,
      error: error.message,
    };
  }
}

async function dashboard() {
  const [recorders, reports, schedules, filesystem] = await Promise.all([
    Promise.all(runtimeSettings.channels.map(channelStatus)),
    directoryFiles(config.reportsDirectory, (name) => name.endsWith(".xlsx")),
    directoryFiles(config.schedulesDirectory, (name) => name.endsWith(".json")),
    statfs(config.reportsDirectory),
  ]);
  const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  const recordingFiles = recorders.reduce(
    (sum, recorder) => sum + recorder.recordingFiles,
    0,
  );
  return {
    serverTimeKst: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date()),
    recorders,
    reportChannels: runtimeSettings.channels
      .filter((channel) => channel.reportEnabled)
      .map(({ id, name }) => ({ id, name })),
    storage: {
      totalBytes,
      availableBytes,
      usedPercent:
        totalBytes === 0
          ? 0
          : ((totalBytes - availableBytes) / totalBytes) * 100,
      estimatedDaysRemaining:
        availableBytes /
        (33_300_000_000 * Math.max(1, runtimeSettings.channels.length)),
    },
    counts: {
      reports: reports.length,
      schedules: schedules.length,
      recordingFiles,
    },
    recentReports: reports.slice(0, 5),
  };
}

function publicJob(job) {
  return {
    id: job.id,
    date: job.date,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    output: job.output,
    reportName: job.reportName,
    channelId: job.channelId,
    channelName: job.channelName,
  };
}

function publicAudioJob(job) {
  return {
    id: job.id,
    date: job.date,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    output: job.output,
    channelId: job.channelId,
    channelName: job.channelName,
  };
}

function appendJobOutput(job, chunk) {
  job.output += chunk.toString("utf8");
  if (job.output.length > maxJobLogCharacters) {
    job.output = job.output.slice(-maxJobLogCharacters);
  }
}

function enqueueAudioJob(channel, date) {
  const duplicate = [...audioJobs.values()].find(
    (job) =>
      job.channelId === channel.id &&
      job.date === date &&
      ["queued", "running"].includes(job.state),
  );
  if (duplicate) return duplicate;

  const job = {
    id: randomUUID(),
    date,
    state: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    output: "편성 오디오 작업이 대기열에 추가되었습니다.\n",
    channelId: channel.id,
    channelName: channel.name,
    recordingsDirectory: channel.recordingsDirectory,
    schedulePath: schedulePath(channel, date),
    audioOutputPath: programAudioPath(channel, date),
  };
  audioJobs.set(job.id, job);
  audioQueue.push(job);
  while (audioJobs.size > 100) {
    const oldest = audioJobs.keys().next().value;
    if (["queued", "running"].includes(audioJobs.get(oldest)?.state)) break;
    audioJobs.delete(oldest);
  }
  void runNextAudioJob();
  return job;
}

async function runNextAudioJob() {
  if (audioWorkerBusy) return;
  const job = audioQueue.shift();
  if (!job) return;
  audioWorkerBusy = true;
  job.state = "running";
  job.startedAt = new Date().toISOString();
  appendJobOutput(
    job,
    `백그라운드 작업 시작: ${job.channelName} ${job.date}\n`,
  );

  const args = [
    "--audio-only",
    "--date",
    job.date,
    "--recordings",
    job.recordingsDirectory,
    "--schedule-json",
    job.schedulePath,
    "--audio-output",
    job.audioOutputPath,
    "--force",
  ];
  const child = spawn(config.reportExecutable, args, {
    cwd: projectDirectory,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => appendJobOutput(job, chunk));
  child.stderr.on("data", (chunk) => appendJobOutput(job, chunk));

  let finalized = false;
  const finish = (state, code, message = "") => {
    if (finalized) return;
    finalized = true;
    if (message) appendJobOutput(job, `\n${message}\n`);
    job.exitCode = code;
    job.state = state;
    job.finishedAt = new Date().toISOString();
    audioWorkerBusy = false;
    void runNextAudioJob();
  };
  child.on("error", (error) => finish("failed", null, error.message));
  child.on("close", (code) => {
    finish(code === 0 ? "completed" : code === 2 ? "warning" : "failed", code);
  });
}

async function startReportJob(channel, date) {
  await readSchedule(channel, date);
  for (const job of jobs.values()) {
    if (job.state === "running" || job.state === "queued") {
      throw httpError(409, "이미 리포트 계산 작업이 실행 중입니다.");
    }
  }
  const id = randomUUID();
  const output = reportPath(channel, date);
  const job = {
    id,
    date,
    state: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    output: "",
    reportName: output.split(sep).at(-1),
    channelId: channel.id,
    channelName: channel.name,
  };
  job.completion = new Promise((resolveCompletion) => {
    job.resolveCompletion = resolveCompletion;
  });
  jobs.set(id, job);

  const args = [
    "--date",
    date,
    "--recordings",
    channel.recordingsDirectory,
    "--schedule-json",
    schedulePath(channel, date),
    "--schedule-output",
    schedulePath(channel, date),
    "--output",
    output,
    "--no-audio",
    "--force",
  ];
  const child = spawn(config.reportExecutable, args, {
    cwd: projectDirectory,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.state = "running";
  job.startedAt = new Date().toISOString();
  child.stdout.on("data", (chunk) => appendJobOutput(job, chunk));
  child.stderr.on("data", (chunk) => appendJobOutput(job, chunk));
  child.on("error", (error) => {
    job.state = "failed";
    job.finishedAt = new Date().toISOString();
    appendJobOutput(job, `\n${error.message}\n`);
    job.resolveCompletion(job);
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.state = code === 0 ? "completed" : code === 2 ? "warning" : "failed";
    if (code === 0 || code === 2) {
      const audioJob = enqueueAudioJob(channel, date);
      appendJobOutput(
        job,
        `\n편성 오디오는 백그라운드 작업 ${audioJob.id}에서 생성됩니다.\n`,
      );
    }
    job.resolveCompletion(job);
  });
  return job;
}

function kstNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function hasActiveReportJob() {
  return [...jobs.values()].some((job) =>
    ["queued", "running"].includes(job.state),
  );
}

async function waitForReportSlot() {
  while (hasActiveReportJob()) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
}

async function runScheduledReports(runDateKst, broadcastDate) {
  const channels = runtimeSettings.channels.filter(
    (channel) => channel.reportEnabled,
  );
  schedulerState = {
    lastAttemptDateKst: runDateKst,
    broadcastDate,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };
  await saveSchedulerState();
  console.log(
    `자동 리포트 시작: 방송일=${broadcastDate}, 채널=${channels.length}`,
  );

  for (const channel of channels) {
    const result = {
      channelId: channel.id,
      channelName: channel.name,
      state: "running",
      message: "",
      reportName: null,
    };
    schedulerState.results.push(result);
    await saveSchedulerState();
    try {
      await fetchSchedule(channel, broadcastDate);
      await waitForReportSlot();
      const job = await startReportJob(channel, broadcastDate);
      await job.completion;
      result.state = job.state;
      result.reportName = job.reportName;
      result.message =
        job.state === "completed"
          ? "리포트 생성 완료"
          : job.output.slice(-2_000);
    } catch (error) {
      result.state = "failed";
      result.message = error.message;
      console.error(`자동 리포트 실패 (${channel.name}): ${error.message}`);
    }
    await saveSchedulerState();
  }

  schedulerState.status = schedulerState.results.some(
    (result) => result.state === "failed",
  )
    ? "failed"
    : schedulerState.results.some((result) => result.state === "warning")
      ? "warning"
      : "completed";
  schedulerState.finishedAt = new Date().toISOString();
  await saveSchedulerState();
  console.log(
    `자동 리포트 종료: 방송일=${broadcastDate}, 상태=${schedulerState.status}`,
  );
}

async function checkReportSchedule() {
  if (schedulerBusy || !runtimeSettings.reportSchedule.enabled) return;
  const now = kstNowParts();
  if (
    now.time < runtimeSettings.reportSchedule.timeKst ||
    schedulerState.lastAttemptDateKst === now.date
  ) {
    return;
  }
  schedulerBusy = true;
  try {
    await runScheduledReports(now.date, previousDate(now.date));
  } catch (error) {
    console.error(`자동 리포트 스케줄러 오류: ${error.stack || error.message}`);
  } finally {
    schedulerBusy = false;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  sendJson(response, status, {
    error: status >= 500 && !error?.status ? "서버 내부 오류가 발생했습니다." : error.message,
  });
}

async function sendFile(response, path, contentType, downloadName = null) {
  const info = await stat(path);
  const headers = {
    "Content-Type": contentType,
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
  };
  if (downloadName) {
    headers["Content-Disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  response.writeHead(200, headers);
  createReadStream(path).pipe(response);
}

async function sendAudioFile(request, response, path) {
  const info = await stat(path);
  const range = request.headers.range;
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      throw httpError(416, "올바르지 않은 오디오 범위 요청입니다.");
    }
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
    } else {
      const suffix = Number(match[2]);
      start = Math.max(0, info.size - suffix);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= info.size) {
      throw httpError(416, "요청한 오디오 범위를 읽을 수 없습니다.");
    }
    end = Math.min(end, info.size - 1);
    status = 206;
  }
  const headers = {
    "Content-Type": "audio/wav",
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
  };
  if (status === 206) {
    headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  }
  response.writeHead(status, headers);
  createReadStream(path, { start, end }).pipe(response);
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/api/dashboard") {
    return sendJson(response, 200, await dashboard());
  }
  if (request.method === "GET" && pathname === "/api/settings") {
    return sendJson(response, 200, runtimeSettings);
  }
  if (request.method === "GET" && pathname === "/api/scheduler") {
    return sendJson(response, 200, schedulerState);
  }
  if (request.method === "PUT" && pathname === "/api/settings") {
    return sendJson(
      response,
      200,
      await saveRuntimeSettings(await readJsonBody(request)),
    );
  }
  if (request.method === "GET" && pathname === "/api/schedule") {
    const channel = requireChannel(url.searchParams.get("channelId"), true);
    const date = requireDate(url.searchParams.get("date"));
    return sendJson(response, 200, await readSchedule(channel, date));
  }
  if (request.method === "POST" && pathname === "/api/schedule/fetch") {
    const body = await readJsonBody(request);
    const channel = requireChannel(body.channelId, true);
    const date = requireDate(body.date);
    return sendJson(response, 200, await fetchSchedule(channel, date));
  }
  if (request.method === "PUT" && pathname === "/api/schedule") {
    const body = await readJsonBody(request);
    const channel = requireChannel(body.channelId, true);
    const date = requireDate(body.date);
    const schedule = validateSchedule(body.schedule, date);
    schedule.channelId = channel.id;
    schedule.channelName = channel.name;
    await atomicWriteJson(schedulePath(channel, date), schedule);
    return sendJson(response, 200, schedule);
  }
  if (request.method === "POST" && pathname === "/api/reports") {
    const body = await readJsonBody(request);
    const channel = requireChannel(body.channelId, true);
    return sendJson(
      response,
      202,
      publicJob(await startReportJob(channel, requireDate(body.date))),
    );
  }
  if (request.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const id = pathname.slice("/api/jobs/".length);
    const job = jobs.get(id);
    if (!job) throw httpError(404, "작업을 찾을 수 없습니다.");
    return sendJson(response, 200, publicJob(job));
  }
  if (request.method === "GET" && pathname === "/api/reports") {
    return sendJson(
      response,
      200,
      await directoryFiles(config.reportsDirectory, (name) =>
        name.endsWith(".xlsx"),
      ),
    );
  }
  if (request.method === "GET" && pathname === "/api/audio-jobs") {
    return sendJson(
      response,
      200,
      [...audioJobs.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 20)
        .map(publicAudioJob),
    );
  }
  if (request.method === "GET" && pathname === "/api/program-audio") {
    const channel = requireChannel(url.searchParams.get("channelId"), true);
    const date = requireDate(url.searchParams.get("date"));
    const rebuilding = [...audioJobs.values()].some(
      (job) =>
        job.channelId === channel.id &&
        job.date === date &&
        ["queued", "running"].includes(job.state),
    );
    if (rebuilding) return sendJson(response, 200, []);
    return sendJson(
      response,
      200,
      await directoryFiles(
        programAudioPath(channel, date),
        (name) => name.endsWith(".wav"),
      ),
    );
  }
  if (request.method === "GET" && pathname === "/api/program-audio/file") {
    const channel = requireChannel(url.searchParams.get("channelId"), true);
    const date = requireDate(url.searchParams.get("date"));
    const name = String(url.searchParams.get("name") || "");
    if (
      !name ||
      name.length > 255 ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !name.endsWith(".wav")
    ) {
      throw httpError(400, "올바르지 않은 편성 오디오 파일명입니다.");
    }
    return sendAudioFile(
      request,
      response,
      join(programAudioPath(channel, date), name),
    );
  }
  if (
    request.method === "GET" &&
    pathname.startsWith("/api/reports/") &&
    pathname.endsWith("/download")
  ) {
    const encoded = pathname.slice(
      "/api/reports/".length,
      -"/download".length,
    );
    const name = decodeURIComponent(encoded);
    if (
      !name ||
      name.length > 255 ||
      name.includes("/") ||
      name.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      !name.endsWith(".xlsx")
    ) {
      throw httpError(400, "올바르지 않은 리포트 파일명입니다.");
    }
    return sendFile(
      response,
      join(config.reportsDirectory, name),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name,
    );
  }
  if (pathname.startsWith("/api/")) {
    throw httpError(404, "API 요청 경로를 찾을 수 없습니다.");
  }
  if (request.method === "GET" && pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    return response.end();
  }

  if (request.method !== "GET") {
    throw httpError(404, "요청 경로를 찾을 수 없습니다.");
  }
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = resolve(publicDirectory, relative);
  if (!resolved.startsWith(`${publicDirectory}${sep}`)) {
    throw httpError(403, "허용되지 않은 경로입니다.");
  }
  try {
    return await sendFile(
      response,
      resolved,
      mimeTypes[extname(resolved)] || "application/octet-stream",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return await sendFile(
        response,
        join(publicDirectory, "index.html"),
        mimeTypes[".html"],
      );
    }
    throw error;
  }
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => sendError(response, error));
});

server.listen(config.port, config.host, () => {
  console.log(
    `Loudness Console: http://${config.host}:${config.port} ` +
      `(channels=${runtimeSettings.channels.length}, ` +
      `settings=${config.runtimeSettingsFile})`,
  );
});

const schedulerStartupTimer = setTimeout(() => {
  void checkReportSchedule();
}, 1_000);
const schedulerTimer = setInterval(() => {
  void checkReportSchedule();
}, 30_000);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(schedulerStartupTimer);
    clearInterval(schedulerTimer);
    server.close(() => process.exit(0));
  });
}
