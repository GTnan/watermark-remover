const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 1024 * 1024 * 1024);
const VSR_ENGINE = process.env.VSR_ENGINE || "docker";
const VSR_DOCKER_IMAGE = process.env.VSR_DOCKER_IMAGE || "eritpchy/video-subtitle-remover:1.4.0-cpu";
const VSR_MAIN = process.env.VSR_MAIN || "";
const VSR_PYTHON = process.env.VSR_PYTHON || "python3";

for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const uploads = new Map();
const jobs = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload), { "content-type": "application/json; charset=utf-8" });
}

function safeName(name) {
  const ext = path.extname(name || "").toLowerCase();
  const allowedExt = [".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"];
  return allowedExt.includes(ext) ? ext : ".mp4";
}

function getBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function streamUpload(req, filePath) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const file = fs.createWriteStream(filePath);
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        file.destroy();
        fs.rm(filePath, { force: true }, () => {});
        reject(new Error("视频超过服务器限制"));
        req.destroy();
      }
    });
    req.pipe(file);
    file.on("finish", () => resolve(size));
    file.on("error", reject);
    req.on("error", reject);
  });
}

function resolvePublicFile(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!fullPath.startsWith(PUBLIC_DIR)) return null;
  return fullPath;
}

function ffmpegArgs(input, output, opts) {
  const mode = opts.mode || "sttn";
  const x = Math.max(0, Number(opts.x || 0));
  const y = Math.max(0, Number(opts.y || 0));
  const w = Math.max(1, Number(opts.w || 1));
  const h = Math.max(1, Number(opts.h || 1));
  const blur = mode === "lama" ? 3 : mode === "propainter" ? 6 : 4;
  return [
    "-y",
    "-i", input,
    "-vf", `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0,boxblur=luma_radius=${blur}:luma_power=1:enable='between(t,0,999999)'`,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-c:a", "copy",
    "-movflags", "+faststart",
    output
  ];
}

function normalizeVsrMode(mode) {
  if (mode === "lama") return "lama";
  if (mode === "propainter") return "propainter";
  return "sttn-auto";
}

function dockerDataPath(filePath) {
  const relative = path.relative(DATA_DIR, filePath).split(path.sep).join("/");
  return `/data/${relative}`;
}

function vsrCliArgs(input, output, opts, dockerPaths = false) {
  const inPath = dockerPaths ? dockerDataPath(input) : input;
  const outPath = dockerPaths ? dockerDataPath(output) : output;
  const x = Math.max(0, Math.round(Number(opts.x || 0)));
  const y = Math.max(0, Math.round(Number(opts.y || 0)));
  const w = Math.max(1, Math.round(Number(opts.w || 1)));
  const h = Math.max(1, Math.round(Number(opts.h || 1)));
  return [
    "backend/main.py",
    "--input", inPath,
    "--output", outPath,
    "--subtitle-area-coords", String(y), String(y + h), String(x), String(x + w),
    "--inpaint-mode", normalizeVsrMode(opts.mode)
  ];
}

function vsrCommand(input, output, opts) {
  if (VSR_ENGINE === "python" && VSR_MAIN) {
    return {
      command: VSR_PYTHON,
      args: [VSR_MAIN, ...vsrCliArgs(input, output, opts).slice(1)]
    };
  }
  return {
    command: "docker",
    args: [
      "run", "--rm",
      "-v", `${DATA_DIR}:/data`,
      VSR_DOCKER_IMAGE,
      "python",
      ...vsrCliArgs(input, output, opts, true)
    ]
  };
}

function runCommand(job, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT });
    job.pid = child.pid;
    child.stdout.on("data", chunk => {
      appendJobLog(job, chunk.toString());
      if (job.logs.length > 80) job.logs.shift();
    });
    child.stderr.on("data", chunk => {
      appendJobLog(job, chunk.toString());
      if (job.logs.length > 80) job.logs.shift();
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}

function timeToSeconds(value) {
  const match = String(value).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function updateProgressFromLog(job, text) {
  const durationMatch = text.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
  if (durationMatch) job.durationSeconds = timeToSeconds(durationMatch[1]);

  const timeMatches = [...text.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
  if (timeMatches.length && job.durationSeconds) {
    const seconds = timeToSeconds(timeMatches.at(-1)[1]);
    job.progress = Math.max(job.progress || 0, Math.min(99, Math.round((seconds / job.durationSeconds) * 100)));
  }

  const percentMatches = [...text.matchAll(/(\d{1,3})%/g)];
  if (percentMatches.length) {
    const percent = Number(percentMatches.at(-1)[1]);
    if (Number.isFinite(percent)) job.progress = Math.max(job.progress || 0, Math.min(99, percent));
  }

  if (!job.progress && /frame=|Processing|inpaint|detect|remove|subtitle/i.test(text)) {
    job.progress = 5;
  }
}

function appendJobLog(job, text) {
  updateProgressFromLog(job, text);
  job.logs.push(text);
}

async function processJob(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const upload = uploads.get(job.uploadId);
  const output = path.join(OUTPUT_DIR, `${job.id}.mp4`);
  job.outputPath = output;

  try {
    if (!upload) throw new Error("找不到上传的视频");
    if (job.engine === "vsr") {
      const vsr = vsrCommand(upload.path, output, job.options);
      await runCommand(job, vsr.command, vsr.args);
    } else {
      await runCommand(job, "ffmpeg", ffmpegArgs(upload.path, output, job.options));
    }
    job.status = "done";
    job.downloadUrl = `/api/download/${job.id}`;
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

function handleDownload(req, res, id) {
  const job = jobs.get(id);
  if (!job || job.status !== "done" || !fs.existsSync(job.outputPath)) {
    json(res, 404, { error: "结果不存在或尚未完成" });
    return;
  }
  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-disposition": `attachment; filename="removed-${id}.mp4"`
  });
  fs.createReadStream(job.outputPath).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "PUT" && url.pathname === "/api/upload") {
    const id = crypto.randomUUID();
    const ext = safeName(url.searchParams.get("name"));
    const filePath = path.join(UPLOAD_DIR, `${id}${ext}`);
    try {
      const bytes = await streamUpload(req, filePath);
      const record = { id, path: filePath, bytes, filename: url.searchParams.get("name") || `video${ext}` };
      uploads.set(id, record);
      json(res, 201, { uploadId: id, bytes, filename: record.filename });
    } catch (error) {
      json(res, 413, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/jobs") {
    try {
      const body = JSON.parse(await getBody(req));
      if (!uploads.has(body.uploadId)) {
        json(res, 400, { error: "请先上传视频" });
        return;
      }
      const id = crypto.randomUUID();
      const job = {
        id,
        uploadId: body.uploadId,
        engine: body.engine === "vsr" ? "vsr" : "ffmpeg",
        options: body.options || {},
        status: "queued",
        progress: 0,
        logs: [],
        createdAt: new Date().toISOString()
      };
      jobs.set(id, job);
      processJob(job);
      json(res, 202, { jobId: id, status: job.status });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const id = url.pathname.split("/").pop();
    const job = jobs.get(id);
    if (!job) {
      json(res, 404, { error: "任务不存在" });
      return;
    }
    json(res, 200, {
      id: job.id,
      status: job.status,
      engine: job.engine,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      downloadUrl: job.downloadUrl,
      progress: job.status === "done" ? 100 : job.progress || 0,
      logs: job.logs.slice(-12).join("")
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/download/")) {
    handleDownload(req, res, url.pathname.split("/").pop());
    return;
  }

  if (req.method === "GET") {
    const filePath = resolvePublicFile(url.pathname);
    if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  json(res, 404, { error: "Not found" });
}

http.createServer((req, res) => {
  route(req, res).catch(error => json(res, 500, { error: error.message }));
}).listen(PORT, HOST, () => {
  console.log(`Watermark remover listening on http://${HOST}:${PORT}`);
  if (VSR_ENGINE === "python" && VSR_MAIN) console.log(`VSR enabled: ${VSR_PYTHON} ${VSR_MAIN}`);
  else console.log(`VSR enabled through Docker image: ${VSR_DOCKER_IMAGE}`);
});
