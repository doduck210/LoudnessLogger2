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
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(webDirectory, "..");
const publicDirectory = join(webDirectory, "public");

const config = Object.freeze({
  host: process.env.LOUDNESS_WEB_HOST || "0.0.0.0",
  port: parsePort(process.env.LOUDNESS_WEB_PORT || "8080"),
  recordingsDirectory: resolve(
    process.env.LOUDNESS_RECORDINGS_DIR || "/mnt/hdd/recordings",
  ),
  schedulesDirectory: resolve(
    process.env.LOUDNESS_SCHEDULES_DIR || "/mnt/hdd/schedules",
  ),
  reportsDirectory: resolve(
    process.env.LOUDNESS_REPORTS_DIR || "/mnt/hdd/reports",
  ),
  reportExecutable: resolve(
    process.env.LOUDNESS_REPORT_EXECUTABLE ||
      join(projectDirectory, "loudness_report"),
  ),
  apiBaseUrl:
    process.env.LOUDNESS_SCHEDULE_API ||
    "http://10.110.21.31/cms/api/frmtn/dailyInfo.json",
  channelName: process.env.LOUDNESS_CHANNEL || "SBS_HD",
});

const jobs = new Map();
const maxRequestBytes = 8 * 1024 * 1024;
const maxJobLogCharacters = 200_000;

await Promise.all([
  mkdir(config.schedulesDirectory, { recursive: true }),
  mkdir(config.reportsDirectory, { recursive: true }),
]);

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid LOUDNESS_WEB_PORT: ${value}`);
  }
  return port;
}

function schedulePath(date) {
  return join(
    config.schedulesDirectory,
    `${config.channelName}_Schedule_${date}.json`,
  );
}

function reportPath(date) {
  return join(
    config.reportsDirectory,
    `${config.channelName}_Loudness_Report_${date}.xlsx`,
  );
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

async function readSchedule(date) {
  try {
    const text = await readFile(schedulePath(date), "utf8");
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

async function fetchSchedule(date) {
  const url = new URL(config.apiBaseUrl);
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
  await atomicWriteJson(schedulePath(date), value);
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

async function dashboard() {
  const [recordings, reports, schedules, filesystem] = await Promise.all([
    directoryFiles(
      config.recordingsDirectory,
      (name) => name.endsWith(".wav") || name.endsWith("_mlkfs.csv"),
    ),
    directoryFiles(config.reportsDirectory, (name) => name.endsWith(".xlsx")),
    directoryFiles(config.schedulesDirectory, (name) => name.endsWith(".json")),
    statfs(config.recordingsDirectory),
  ]);
  const latestWav = recordings.find((file) => file.name.endsWith(".wav"));
  const latestCsv = recordings.find((file) => file.name.endsWith("_mlkfs.csv"));
  const lastWrite = latestWav
    ? Date.now() - Date.parse(latestWav.modifiedAt)
    : Infinity;
  const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  return {
    serverTimeKst: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Seoul",
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date()),
    recorder: {
      state: lastWrite < 20_000 ? "recording" : "idle",
      latestWav: latestWav || null,
      latestMlkfs: latestCsv || null,
    },
    storage: {
      totalBytes,
      availableBytes,
      usedPercent:
        totalBytes === 0
          ? 0
          : ((totalBytes - availableBytes) / totalBytes) * 100,
      estimatedDaysRemaining: availableBytes / 33_300_000_000,
    },
    counts: {
      reports: reports.length,
      schedules: schedules.length,
      recordingFiles: recordings.length,
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
  };
}

function appendJobOutput(job, chunk) {
  job.output += chunk.toString("utf8");
  if (job.output.length > maxJobLogCharacters) {
    job.output = job.output.slice(-maxJobLogCharacters);
  }
}

async function startReportJob(date) {
  await readSchedule(date);
  for (const job of jobs.values()) {
    if (job.state === "running" || job.state === "queued") {
      throw httpError(409, "이미 리포트 계산 작업이 실행 중입니다.");
    }
  }
  const id = randomUUID();
  const output = reportPath(date);
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
  };
  jobs.set(id, job);

  const args = [
    "--date",
    date,
    "--recordings",
    config.recordingsDirectory,
    "--schedule-json",
    schedulePath(date),
    "--schedule-output",
    schedulePath(date),
    "--output",
    output,
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
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.state = code === 0 ? "completed" : code === 2 ? "warning" : "failed";
  });
  return publicJob(job);
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
  if (request.method === "GET" && pathname === "/api/schedule") {
    const date = requireDate(url.searchParams.get("date"));
    return sendJson(response, 200, await readSchedule(date));
  }
  if (request.method === "POST" && pathname === "/api/schedule/fetch") {
    const body = await readJsonBody(request);
    const date = requireDate(body.date);
    return sendJson(response, 200, await fetchSchedule(date));
  }
  if (request.method === "PUT" && pathname === "/api/schedule") {
    const body = await readJsonBody(request);
    const date = requireDate(body.date);
    const schedule = validateSchedule(body.schedule, date);
    await atomicWriteJson(schedulePath(date), schedule);
    return sendJson(response, 200, schedule);
  }
  if (request.method === "POST" && pathname === "/api/reports") {
    const body = await readJsonBody(request);
    return sendJson(response, 202, await startReportJob(requireDate(body.date)));
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
      name.includes("/") ||
      name.includes("\\") ||
      !/^[A-Za-z0-9_.-]+\.xlsx$/.test(name)
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
      `(recordings=${config.recordingsDirectory})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
