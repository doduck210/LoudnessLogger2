import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDeflateRaw, createGzip, inflateRawSync } from "node:zlib";

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
  logsDirectory: join(projectDirectory, "logs"),
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
  logsDirectory: resolve(serverSettings.logsDirectory),
});

const defaultRuntimeSettings = Object.freeze({
  scheduleApi: serverSettings.scheduleApi,
  reportSchedule: {
    enabled: true,
    timeKst: "08:00",
  },
  maintenance: {
    webLogsDays: 0,
  },
  channels: [
    {
      id: "decklink2",
      name: "DeckLink 2",
      recordingsDirectory: "/mnt/hdd/recordings/decklink2",
      recorderLogName: "recorder-port2.log",
      reportEnabled: true,
      retention: {
        wavDays: 0,
        mlkfsDays: 0,
        programAudioDays: 0,
        schedulesDays: 0,
        reportsDays: 0,
        recorderLogsDays: 0,
      },
    },
    {
      id: "decklink3",
      name: "DeckLink 3",
      recordingsDirectory: "/mnt/hdd/recordings/decklink3",
      recorderLogName: "recorder-port3.log",
      reportEnabled: true,
      retention: {
        wavDays: 0,
        mlkfsDays: 0,
        programAudioDays: 0,
        schedulesDays: 0,
        reportsDays: 0,
        recorderLogsDays: 0,
      },
    },
    {
      id: "decklink4",
      name: "DeckLink 4",
      recordingsDirectory: "/mnt/hdd/recordings/decklink4",
      recorderLogName: "recorder-port4.log",
      reportEnabled: false,
      retention: {
        wavDays: 0,
        mlkfsDays: 0,
        programAudioDays: 0,
        schedulesDays: 0,
        reportsDays: 0,
        recorderLogsDays: 0,
      },
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
  mkdir(config.logsDirectory, { recursive: true }),
]);
let runtimeSettings = await loadRuntimeSettings();
let schedulerState = await loadSchedulerState();
let schedulerBusy = false;
let archiveDownloadBusy = false;

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
  const rawMaintenance = value.maintenance || {};
  const webLogsDays = Number(rawMaintenance.webLogsDays ?? 0);
  if (
    !Number.isInteger(webLogsDays) ||
    webLogsDays < 0 ||
    webLogsDays > 3650
  ) {
    throw httpError(400, "웹 운영 로그 보관기간은 0~3650일의 정수여야 합니다.");
  }
  const maintenance = { webLogsDays };
  const legacyRetention = value.retention || {};
  const validateRetention = (raw, channelName) => {
    const retentionValue = (name, label, fallback = 0) => {
      const days = Number(raw?.[name] ?? fallback);
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        throw httpError(
          400,
          `${channelName} ${label} 보관기간은 0~3650일의 정수여야 합니다.`,
        );
      }
      return days;
    };
    const legacyRecordingsDays = raw?.recordingsDays ?? 0;
    return {
      wavDays: retentionValue("wavDays", "원본 WAV", legacyRecordingsDays),
      mlkfsDays: retentionValue(
        "mlkfsDays",
        "M-LKFS CSV",
        legacyRecordingsDays,
      ),
      programAudioDays: retentionValue("programAudioDays", "편성 오디오"),
      schedulesDays: retentionValue("schedulesDays", "편성표"),
      reportsDays: retentionValue("reportsDays", "리포트"),
      recorderLogsDays: retentionValue("recorderLogsDays", "레코더 로그"),
    };
  };
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
    const recorderLogName = String(
      channel?.recorderLogName || defaultRecorderLogName(id),
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
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.log$/.test(recorderLogName) ||
      recorderLogName === "web.log"
    ) {
      throw httpError(
        400,
        `${name}의 레코더 로그 파일명이 올바르지 않습니다.`,
      );
    }
    const reportEnabled =
      typeof channel.reportEnabled === "boolean"
        ? channel.reportEnabled
        : id === legacyReportChannelId;
    const retention = validateRetention(
      channel.retention || legacyRetention,
      name,
    );
    return {
      id,
      name,
      recordingsDirectory: resolve(recordingsDirectory),
      recorderLogName,
      reportEnabled,
      retention,
    };
  });
  if (!channels.some((channel) => channel.reportEnabled)) {
    throw httpError(400, "리포트 대상 채널을 하나 이상 선택해야 합니다.");
  }
  return {
    scheduleApi: parsedScheduleApi.toString(),
    reportSchedule,
    maintenance,
    channels,
  };
}

function defaultRecorderLogName(channelId) {
  const port = /(\d+)$/.exec(channelId)?.[1];
  return port ? `recorder-port${port}.log` : `recorder-${channelId}.log`;
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
      lastCleanupDateKst:
        typeof value.lastCleanupDateKst === "string"
          ? value.lastCleanupDateKst
          : null,
      lastCleanupAt:
        typeof value.lastCleanupAt === "string" ? value.lastCleanupAt : null,
      cleanupResult:
        value.cleanupResult && typeof value.cleanupResult === "object"
          ? value.cleanupResult
          : null,
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
      lastCleanupDateKst: null,
      lastCleanupAt: null,
      cleanupResult: null,
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

async function existingReportPath(channel, date) {
  const current = reportPath(channel, date);
  try {
    await stat(current);
    return current;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const legacy = join(
    config.reportsDirectory,
    `${channel.id}_Loudness_Report_${date}.xlsx`,
  );
  try {
    await stat(legacy);
    return legacy;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw httpError(404, "생성된 리포트가 없습니다.");
    }
    throw error;
  }
}

function programAudioPath(channel, date) {
  return join(config.programAudioDirectory, channelFileName(channel), date);
}

function zipEntry(archive, targetName) {
  let offset = 0;
  while (offset + 30 <= archive.length) {
    if (archive.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length || (flags & 0x08) !== 0) {
      throw new Error("지원하지 않는 XLSX ZIP 구조입니다.");
    }
    const name = archive.toString("utf8", nameStart, nameStart + nameLength);
    if (name === targetName) {
      const data = archive.subarray(dataStart, dataEnd);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`지원하지 않는 XLSX 압축 방식입니다: ${method}`);
    }
    offset = dataEnd;
  }
  throw new Error(`XLSX 내부 파일을 찾을 수 없습니다: ${targetName}`);
}

function decodeXmlText(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function worksheetCell(rowXml, column, rowNumber) {
  const pattern = new RegExp(
    `<c\\b[^>]*r="${column}${rowNumber}"[^>]*>([\\s\\S]*?)<\\/c>`,
  );
  const cell = pattern.exec(rowXml)?.[1];
  if (!cell) return null;
  const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1];
  if (inline !== undefined) return decodeXmlText(inline);
  const number = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
  return number === undefined ? null : decodeXmlText(number);
}

async function readReportData(channel, date) {
  const path = await existingReportPath(channel, date);
  const archive = await readFile(path);
  const worksheet = zipEntry(
    archive,
    "xl/worksheets/sheet1.xml",
  ).toString("utf8");
  const rows = [];
  const rowPattern = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  for (const match of worksheet.matchAll(rowPattern)) {
    const rowNumber = Number(match[1]);
    if (rowNumber === 1) continue;
    const ilkfsText = worksheetCell(match[2], "D", rowNumber);
    rows.push({
      index: rowNumber - 1,
      startTime: worksheetCell(match[2], "A", rowNumber),
      endTime: worksheetCell(match[2], "B", rowNumber),
      duration: worksheetCell(match[2], "C", rowNumber),
      ilkfs:
        ilkfsText === null || !Number.isFinite(Number(ilkfsText))
          ? null
          : Number(ilkfsText),
      title: worksheetCell(match[2], "E", rowNumber),
      programId: worksheetCell(match[2], "F", rowNumber),
    });
  }
  return {
    reportName: path.split(sep).at(-1),
    rows,
  };
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

function requireMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) {
    throw httpError(400, "월은 YYYY-MM 형식이어야 합니다.");
  }
  const parsed = new Date(`${value}-01T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 7) !== value
  ) {
    throw httpError(400, "유효하지 않은 월입니다.");
  }
  return value;
}

function requireDateRange(fromValue, toValue, maximumDays = 366) {
  const from = requireDate(fromValue);
  const to = requireDate(toValue);
  const latestDate = previousDate(kstNowParts().date);
  if (to > latestDate) {
    throw httpError(
      400,
      `종료일은 서울 기준 전일(${latestDate})까지만 선택할 수 있습니다.`,
    );
  }
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (toTime < fromTime) {
    throw httpError(400, "종료일은 시작일보다 빠를 수 없습니다.");
  }
  const dayCount = Math.floor((toTime - fromTime) / 86_400_000) + 1;
  if (dayCount > maximumDays) {
    throw httpError(
      400,
      `한 번에 다운로드할 수 있는 기간은 최대 ${maximumDays}일입니다.`,
    );
  }
  const dates = [];
  for (let offset = 0; offset < dayCount; ++offset) {
    dates.push(
      new Date(fromTime + offset * 86_400_000).toISOString().slice(0, 10),
    );
  }
  return { from, to, dates };
}

async function directoryNames(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function rangeArchiveEntries(channel, range) {
  const allowedDates = new Set(range.dates);
  const requestedStart = Date.parse(`${range.from}T00:00:00+09:00`);
  const requestedEnd =
    Date.parse(`${range.to}T00:00:00+09:00`) + 86_400_000;
  let mlkfsCoverageEnd = requestedEnd;
  let lastProgramEnd = null;
  let scheduleLoaded = false;
  let scheduleWarning = null;
  try {
    const schedule = await readSchedule(channel, range.to);
    scheduleLoaded = true;
    for (const item of schedule.items) {
      const start = Date.parse(
        `${item.StartTime.replace(" ", "T")}+09:00`,
      );
      const end = start + Number(item.Duration) * 1_000;
      if (Number.isFinite(end) && (lastProgramEnd === null || end > lastProgramEnd)) {
        lastProgramEnd = end;
      }
    }
    if (lastProgramEnd !== null) {
      mlkfsCoverageEnd = Math.max(mlkfsCoverageEnd, lastProgramEnd);
    }
  } catch (error) {
    scheduleWarning =
      `종료일 ${range.to} 편성표를 읽지 못해 M-LKFS를 자정까지만 포함했습니다: ` +
      error.message;
  }
  const [recordingEntries, reportEntries] = await Promise.all([
    readdir(channel.recordingsDirectory, { withFileTypes: true }),
    readdir(config.reportsDirectory, { withFileTypes: true }),
  ]);
  const rootName =
    `Loudness_Archive_${channelFileName(channel)}_${range.from}_${range.to}`;
  const files = [];
  const counts = new Map(
    range.dates.map((date) => [date, { reports: 0, mlkfs: 0 }]),
  );
  const extensionDate = new Date(`${range.to}T00:00:00Z`);
  for (let offset = 1; offset <= 7; ++offset) {
    extensionDate.setUTCDate(extensionDate.getUTCDate() + 1);
    const date = extensionDate.toISOString().slice(0, 10);
    const dateStart = Date.parse(`${date}T00:00:00+09:00`);
    if (dateStart >= mlkfsCoverageEnd) break;
    counts.set(date, { reports: 0, mlkfs: 0 });
  }
  const mlkfsPattern =
    /^(\d{4}-\d{2}-\d{2})_(\d{2})\.(\d{2})\.(\d{2})_mlkfs(?:_part\d+)?\.csv$/;
  for (const entry of recordingEntries) {
    if (!entry.isFile()) continue;
    const match = mlkfsPattern.exec(entry.name);
    if (!match) continue;
    const date = match[1];
    const fileStart = Date.parse(
      `${date}T${match[2]}:${match[3]}:${match[4]}+09:00`,
    );
    if (
      !Number.isFinite(fileStart) ||
      fileStart < requestedStart ||
      fileStart >= mlkfsCoverageEnd
    ) {
      continue;
    }
    if (!counts.has(date)) {
      counts.set(date, { reports: 0, mlkfs: 0 });
    }
    files.push({
      sourcePath: join(channel.recordingsDirectory, entry.name),
      archivePath: `${rootName}/mlkfs/${date}/${entry.name}`,
    });
    counts.get(date).mlkfs += 1;
  }
  const reportPrefixes = [channelFileName(channel), channel.id]
    .map(escapeRegExp)
    .join("|");
  const reportPattern = new RegExp(
    `^(?:${reportPrefixes})_Loudness_Report_` +
      `(\\d{4}-\\d{2}-\\d{2})\\.xlsx$`,
  );
  for (const entry of reportEntries) {
    if (!entry.isFile()) continue;
    const date = reportPattern.exec(entry.name)?.[1];
    if (!date || !allowedDates.has(date)) continue;
    files.push({
      sourcePath: join(config.reportsDirectory, entry.name),
      archivePath: `${rootName}/reports/${entry.name}`,
    });
    counts.get(date).reports += 1;
  }
  files.sort((left, right) =>
    left.archivePath.localeCompare(right.archivePath, "en"),
  );
  const dateStatus = [...counts]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([date, count]) => ({
      date,
      reportFiles: count.reports,
      mlkfsFiles: count.mlkfs,
      extendedForLastSchedule: date > range.to,
    }));
  const formatKst = (time) =>
    time === null
      ? null
      : new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).format(new Date(time));
  const manifest = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    timeZone: "Asia/Seoul",
    channel: { id: channel.id, name: channel.name },
    range: {
      from: range.from,
      to: range.to,
      days: range.dates.length,
    },
    mlkfsCoverage: {
      requestedEndKst: formatKst(requestedEnd),
      lastDayScheduleLoaded: scheduleLoaded,
      lastProgramEndKst: formatKst(lastProgramEnd),
      includedUntilKst: formatKst(mlkfsCoverageEnd),
      extendedBeyondMidnight: mlkfsCoverageEnd > requestedEnd,
      warning: scheduleWarning,
    },
    totals: {
      reportFiles: dateStatus.reduce(
        (sum, date) => sum + date.reportFiles,
        0,
      ),
      mlkfsFiles: dateStatus.reduce(
        (sum, date) => sum + date.mlkfsFiles,
        0,
      ),
    },
    dates: dateStatus,
  };
  files.unshift({
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    archivePath: `${rootName}/manifest.json`,
  });
  return {
    fileName: `${rootName}.zip`,
    files,
    manifest,
  };
}

async function calendarMonth(channel, month) {
  const [scheduleNames, reportNames, recordingNames, audioDates] =
    await Promise.all([
      directoryNames(config.schedulesDirectory),
      directoryNames(config.reportsDirectory),
      directoryNames(channel.recordingsDirectory),
      directoryNames(join(config.programAudioDirectory, channelFileName(channel))),
    ]);
  const schedules = new Set(scheduleNames);
  const reports = new Set(reportNames);
  const recordingDates = new Set(
    recordingNames
      .map((name) => name.slice(0, 10))
      .filter((date) => date.startsWith(month)),
  );
  const audioDateSet = new Set(audioDates);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const days = [];
  for (let day = 1; day <= dayCount; ++day) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const scheduleName = schedulePath(channel, date).split(sep).at(-1);
    const legacyScheduleName = `${channel.id}_Schedule_${date}.json`;
    const reportName = reportPath(channel, date).split(sep).at(-1);
    const legacyReportName = `${channel.id}_Loudness_Report_${date}.xlsx`;
    const storedReportName = reports.has(reportName)
      ? reportName
      : reports.has(legacyReportName)
        ? legacyReportName
        : null;
    const audioJob = [...audioJobs.values()]
      .filter((job) => job.channelId === channel.id && job.date === date)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    days.push({
      date,
      hasRecording: recordingDates.has(date),
      hasSchedule:
        schedules.has(scheduleName) || schedules.has(legacyScheduleName),
      hasReport: storedReportName !== null,
      hasAudio: audioDateSet.has(date),
      audioJobState: audioJob?.state || null,
      reportName: storedReportName,
    });
  }
  return {
    channelId: channel.id,
    channelName: channel.name,
    month,
    firstWeekday: new Date(`${month}-01T00:00:00Z`).getUTCDay(),
    days,
  };
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
    const text = await readFile(await existingSchedulePath(channel, date), "utf8");
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

async function existingSchedulePath(channel, date) {
  const current = schedulePath(channel, date);
  try {
    await stat(current);
    return current;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const legacy = join(
    config.schedulesDirectory,
    `${channel.id}_Schedule_${date}.json`,
  );
  try {
    await stat(legacy);
    return legacy;
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error("저장된 편성표가 없습니다.");
      missing.code = "ENOENT";
      throw missing;
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
  const inputSchedulePath = await existingSchedulePath(channel, date);
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
  while (jobs.size > 100) {
    const oldest = jobs.keys().next().value;
    if (["queued", "running"].includes(jobs.get(oldest)?.state)) break;
    jobs.delete(oldest);
  }

  const args = [
    "--date",
    date,
    "--recordings",
    channel.recordingsDirectory,
    "--schedule-json",
    inputSchedulePath,
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

function dateDaysBefore(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function validFileDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function protectedJobDates() {
  const dates = new Set();
  for (const job of [...jobs.values(), ...audioJobs.values()]) {
    if (["queued", "running"].includes(job.state)) dates.add(job.date);
  }
  return dates;
}

function mergeRetentionDays(policies, key, days) {
  const previous = policies.get(key);
  policies.set(
    key,
    previous === undefined
      ? days
      : previous === 0 || days === 0
        ? 0
        : Math.max(previous, days),
  );
}

async function cleanupFlatFiles({
  directory,
  days,
  runDate,
  pattern,
  category,
  result,
  protectedDates,
}) {
  if (days === 0) return;
  const cutoff = dateDaysBefore(runDate, days);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    result.errors.push(`${category}: ${error.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const date = pattern.exec(entry.name)?.[1];
    if (
      !date ||
      !validFileDate(date) ||
      date >= cutoff ||
      protectedDates.has(date)
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      await unlink(path);
      result[category].files += 1;
      result[category].bytes += info.size;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        result.errors.push(`${path}: ${error.message}`);
      }
    }
  }
}

async function cleanupProgramAudio({
  channel,
  days,
  runDate,
  result,
  protectedDates,
}) {
  if (days === 0) return;
  const cutoff = dateDaysBefore(runDate, days);
  const channelDirectory = join(
    config.programAudioDirectory,
    channelFileName(channel),
  );
  let dateDirectories;
  try {
    dateDirectories = await readdir(channelDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    result.errors.push(`${channelDirectory}: ${error.message}`);
    return;
  }
  for (const dateEntry of dateDirectories) {
    const date = dateEntry.name;
    if (
      !dateEntry.isDirectory() ||
      !validFileDate(date) ||
      date >= cutoff ||
      protectedDates.has(date)
    ) {
      continue;
    }
    const path = join(channelDirectory, date);
    try {
      await rm(path, { recursive: true, force: false });
      result.programAudio.directories += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        result.errors.push(`${path}: ${error.message}`);
      }
    }
  }
}

async function nextLogArchivePath(logName, runDate) {
  for (let part = 1; part <= 999; ++part) {
    const suffix = part === 1 ? "" : `_part${String(part).padStart(2, "0")}`;
    const path = join(
      config.logsDirectory,
      `${logName}.${runDate}${suffix}.gz`,
    );
    try {
      await stat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return path;
      throw error;
    }
  }
  throw new Error(`${logName}의 로그 압축 파일 번호가 모두 사용 중입니다.`);
}

async function rotateOperationalLog(logName, runDate, result) {
  const source = join(config.logsDirectory, logName);
  let sourceInfo;
  try {
    sourceInfo = await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    result.errors.push(`${source}: ${error.message}`);
    return;
  }
  if (!sourceInfo.isFile() || sourceInfo.size === 0) return;
  let archive;
  try {
    archive = await nextLogArchivePath(logName, runDate);
    await pipeline(
      createReadStream(source),
      createGzip({ level: 6 }),
      createWriteStream(archive, { flags: "wx", mode: 0o640 }),
    );
    await truncate(source, 0);
    const archiveInfo = await stat(archive);
    result.operationalLogs.rotatedFiles += 1;
    result.operationalLogs.sourceBytes += sourceInfo.size;
    result.operationalLogs.archiveBytes += archiveInfo.size;
  } catch (error) {
    if (archive) {
      try {
        await unlink(archive);
      } catch {
        // Report the original rotation error.
      }
    }
    result.errors.push(`${source}: ${error.message}`);
  }
}

async function cleanupOperationalLogs(runDate, result) {
  const policies = new Map([["web.log", runtimeSettings.maintenance.webLogsDays]]);
  for (const channel of runtimeSettings.channels) {
    mergeRetentionDays(
      policies,
      channel.recorderLogName,
      channel.retention.recorderLogsDays,
    );
  }
  for (const [logName, days] of policies) {
    await rotateOperationalLog(logName, runDate, result);
    await cleanupFlatFiles({
      directory: config.logsDirectory,
      days,
      runDate,
      pattern: new RegExp(
        `^${escapeRegExp(logName)}\\.(\\d{4}-\\d{2}-\\d{2})` +
          `(?:_part\\d+)?\\.gz$`,
      ),
      category: "operationalLogs",
      result,
      protectedDates: new Set(),
    });
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runScheduledCleanup(runDateKst) {
  const result = {
    runDateKst,
    maintenancePolicy: runtimeSettings.maintenance,
    channelPolicies: runtimeSettings.channels.map((channel) => ({
      channelId: channel.id,
      channelName: channel.name,
      recorderLogName: channel.recorderLogName,
      retention: channel.retention,
    })),
    recordingWav: { files: 0, bytes: 0 },
    mlkfs: { files: 0, bytes: 0 },
    programAudio: { directories: 0 },
    schedules: { files: 0, bytes: 0 },
    reports: { files: 0, bytes: 0 },
    operationalLogs: {
      rotatedFiles: 0,
      sourceBytes: 0,
      archiveBytes: 0,
      files: 0,
      bytes: 0,
    },
    errors: [],
  };
  const protectedDates = protectedJobDates();
  const wavPolicies = new Map();
  const mlkfsPolicies = new Map();
  for (const channel of runtimeSettings.channels) {
    mergeRetentionDays(
      wavPolicies,
      channel.recordingsDirectory,
      channel.retention.wavDays,
    );
    mergeRetentionDays(
      mlkfsPolicies,
      channel.recordingsDirectory,
      channel.retention.mlkfsDays,
    );
  }
  for (const [directory, days] of wavPolicies) {
    await cleanupFlatFiles({
      directory,
      days,
      runDate: runDateKst,
      pattern:
        /^(\d{4}-\d{2}-\d{2})_\d{2}\.\d{2}\.\d{2}(?:_part\d+)?\.wav$/,
      category: "recordingWav",
      result,
      protectedDates,
    });
  }
  for (const [directory, days] of mlkfsPolicies) {
    await cleanupFlatFiles({
      directory,
      days,
      runDate: runDateKst,
      pattern:
        /^(\d{4}-\d{2}-\d{2})_\d{2}\.\d{2}\.\d{2}_mlkfs(?:_part\d+)?\.csv$/,
      category: "mlkfs",
      result,
      protectedDates,
    });
  }
  for (const channel of runtimeSettings.channels) {
    await cleanupProgramAudio({
      channel,
      days: channel.retention.programAudioDays,
      runDate: runDateKst,
      result,
      protectedDates,
    });
    const filePrefixes = [
      channelFileName(channel),
      channel.id,
    ].map(escapeRegExp).join("|");
    await cleanupFlatFiles({
      directory: config.schedulesDirectory,
      days: channel.retention.schedulesDays,
      runDate: runDateKst,
      pattern: new RegExp(
        `^(?:${filePrefixes})_Schedule_(\\d{4}-\\d{2}-\\d{2})\\.json$`,
      ),
      category: "schedules",
      result,
      protectedDates,
    });
    await cleanupFlatFiles({
      directory: config.reportsDirectory,
      days: channel.retention.reportsDays,
      runDate: runDateKst,
      pattern: new RegExp(
        `^(?:${filePrefixes})_Loudness_Report_(\\d{4}-\\d{2}-\\d{2})\\.xlsx$`,
      ),
      category: "reports",
      result,
      protectedDates,
    });
  }
  await cleanupOperationalLogs(runDateKst, result);
  if (result.errors.length > 100) {
    result.errors = [
      ...result.errors.slice(0, 100),
      `그 밖의 오류 ${result.errors.length - 100}개`,
    ];
  }
  schedulerState.lastCleanupDateKst = runDateKst;
  schedulerState.lastCleanupAt = new Date().toISOString();
  schedulerState.cleanupResult = result;
  await saveSchedulerState();
  console.log(
    "보관기간 정리 완료: " +
      `WAV ${result.recordingWav.files}개, ` +
      `M-LKFS ${result.mlkfs.files}개, ` +
      `편성 오디오 ${result.programAudio.directories}일, ` +
      `편성표 ${result.schedules.files}개, ` +
      `리포트 ${result.reports.files}개, ` +
      `로그 압축 ${result.operationalLogs.rotatedFiles}개, ` +
      `오류 ${result.errors.length}개`,
  );
  return result;
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
    ...schedulerState,
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
  if (now.time < runtimeSettings.reportSchedule.timeKst) return;
  const cleanupDue = schedulerState.lastCleanupDateKst !== now.date;
  const reportDue = schedulerState.lastAttemptDateKst !== now.date;
  if (!cleanupDue && !reportDue) return;
  schedulerBusy = true;
  try {
    if (cleanupDue) await runScheduledCleanup(now.date);
    if (reportDue) {
      await runScheduledReports(now.date, previousDate(now.date));
    }
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
  if (response.headersSent) {
    console.error(error);
    response.destroy(error);
    return;
  }
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

const zipCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; ++bit) {
    value = (value & 1) !== 0
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  return value >>> 0;
});

function updateZipCrc(crc, chunk) {
  let value = crc;
  for (const byte of chunk) {
    value = zipCrcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function zipDosTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

async function writeResponseChunk(response, chunk) {
  if (response.destroyed) {
    throw new Error("다운로드 연결이 종료되었습니다.");
  }
  if (response.write(chunk)) return;
  await new Promise((resolveWait, rejectWait) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolveWait();
    };
    const onClose = () => {
      cleanup();
      rejectWait(new Error("다운로드 연결이 종료되었습니다."));
    };
    const onError = (error) => {
      cleanup();
      rejectWait(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

async function writeZipEntry(response, entry, offset) {
  const name = Buffer.from(entry.archivePath, "utf8");
  if (name.length > 65_535) {
    throw new Error("압축 파일 내부 경로가 너무 깁니다.");
  }
  const info = entry.data
    ? { size: entry.data.length, mtime: new Date() }
    : await stat(entry.sourcePath);
  if (info.size > 0xffff_ffff) {
    throw new Error(
      `단일 파일이 ZIP 제한을 초과했습니다: ${entry.archivePath}`,
    );
  }
  const dos = zipDosTime(info.mtime);
  const localHeader = Buffer.alloc(30 + name.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0808, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(dos.time, 10);
  localHeader.writeUInt16LE(dos.date, 12);
  localHeader.writeUInt16LE(name.length, 26);
  name.copy(localHeader, 30);
  await writeResponseChunk(response, localHeader);

  let crc = 0xffff_ffff;
  let uncompressedSize = 0;
  let compressedSize = 0;
  const deflater = createDeflateRaw({ level: 6 });
  let source = null;
  if (entry.data) {
    crc = updateZipCrc(crc, entry.data);
    uncompressedSize = entry.data.length;
    deflater.end(entry.data);
  } else {
    source = createReadStream(entry.sourcePath);
    source.on("data", (chunk) => {
      crc = updateZipCrc(crc, chunk);
      uncompressedSize += chunk.length;
    });
    source.on("error", (error) => deflater.destroy(error));
    source.pipe(deflater);
  }
  try {
    for await (const chunk of deflater) {
      compressedSize += chunk.length;
      await writeResponseChunk(response, chunk);
    }
  } finally {
    source?.destroy();
    deflater.destroy();
  }
  if (
    compressedSize > 0xffff_ffff ||
    uncompressedSize > 0xffff_ffff
  ) {
    throw new Error(
      `단일 파일이 ZIP 제한을 초과했습니다: ${entry.archivePath}`,
    );
  }
  crc = (crc ^ 0xffff_ffff) >>> 0;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  await writeResponseChunk(response, descriptor);

  return {
    name,
    crc,
    compressedSize,
    uncompressedSize,
    localOffset: offset,
    dos,
    bytesWritten:
      BigInt(localHeader.length) +
      BigInt(compressedSize) +
      BigInt(descriptor.length),
  };
}

function zipCentralHeader(entry) {
  const needsZip64Offset = entry.localOffset > 0xffff_ffffn;
  const extra = needsZip64Offset ? Buffer.alloc(12) : Buffer.alloc(0);
  if (needsZip64Offset) {
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8, 2);
    extra.writeBigUInt64LE(entry.localOffset, 4);
  }
  const header = Buffer.alloc(46 + entry.name.length + extra.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(needsZip64Offset ? 45 : 20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(entry.dos.time, 12);
  header.writeUInt16LE(entry.dos.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt32LE(
    needsZip64Offset ? 0xffff_ffff : Number(entry.localOffset),
    42,
  );
  entry.name.copy(header, 46);
  extra.copy(header, 46 + entry.name.length);
  return header;
}

async function sendRangeArchive(request, response, archive) {
  response.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition":
      `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
    "Cache-Control": "private, no-store",
    "X-Archive-Report-Files": archive.manifest.totals.reportFiles,
    "X-Archive-MLKFS-Files": archive.manifest.totals.mlkfsFiles,
  });
  let offset = 0n;
  const centralEntries = [];
  for (const file of archive.files) {
    if (request.destroyed || response.destroyed) {
      throw new Error("다운로드 연결이 종료되었습니다.");
    }
    const centralEntry = await writeZipEntry(response, file, offset);
    centralEntries.push(centralEntry);
    offset += centralEntry.bytesWritten;
  }
  const centralOffset = offset;
  for (const entry of centralEntries) {
    const header = zipCentralHeader(entry);
    await writeResponseChunk(response, header);
    offset += BigInt(header.length);
  }
  const centralSize = offset - centralOffset;
  const zip64Offset = offset;
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(BigInt(centralEntries.length), 24);
  zip64.writeBigUInt64LE(BigInt(centralEntries.length), 32);
  zip64.writeBigUInt64LE(centralSize, 40);
  zip64.writeBigUInt64LE(centralOffset, 48);
  await writeResponseChunk(response, zip64);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(zip64Offset, 8);
  locator.writeUInt32LE(1, 16);
  await writeResponseChunk(response, locator);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const classicEntries = Math.min(centralEntries.length, 0xffff);
  eocd.writeUInt16LE(classicEntries, 8);
  eocd.writeUInt16LE(classicEntries, 10);
  eocd.writeUInt32LE(
    centralSize > 0xffff_ffffn ? 0xffff_ffff : Number(centralSize),
    12,
  );
  eocd.writeUInt32LE(
    centralOffset > 0xffff_ffffn ? 0xffff_ffff : Number(centralOffset),
    16,
  );
  response.end(eocd);
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
  if (request.method === "GET" && pathname === "/api/calendar") {
    const channel = requireChannel(url.searchParams.get("channelId"), true);
    const month = requireMonth(url.searchParams.get("month"));
    return sendJson(response, 200, await calendarMonth(channel, month));
  }
  if (
    request.method === "GET" &&
    pathname === "/api/archive/download"
  ) {
    if (archiveDownloadBusy) {
      throw httpError(
        409,
        "다른 기간 압축 다운로드가 진행 중입니다. 완료 후 다시 시도하세요.",
      );
    }
    const channel = requireChannel(url.searchParams.get("channelId"), true);
    const range = requireDateRange(
      url.searchParams.get("from"),
      url.searchParams.get("to"),
    );
    archiveDownloadBusy = true;
    try {
      return await sendRangeArchive(
        request,
        response,
        await rangeArchiveEntries(channel, range),
      );
    } finally {
      archiveDownloadBusy = false;
    }
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
  if (request.method === "GET" && pathname === "/api/report-data") {
    const channel = requireChannel(url.searchParams.get("channelId"), true);
    const date = requireDate(url.searchParams.get("date"));
    return sendJson(response, 200, await readReportData(channel, date));
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
