const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const video = document.querySelector("#video");
const canvas = document.querySelector("#canvas");
const emptyState = document.querySelector("#emptyState");
const statusText = document.querySelector("#statusText");
const submit = document.querySelector("#submit");
const download = document.querySelector("#download");
const logs = document.querySelector("#logs");
const fields = {
  engine: document.querySelector("#engine"),
  mode: document.querySelector("#mode"),
  skipDetection: document.querySelector("#skipDetection"),
  x: document.querySelector("#x"),
  y: document.querySelector("#y"),
  w: document.querySelector("#w"),
  h: document.querySelector("#h")
};

let uploadId = "";
let currentFile = null;
let dragStart = null;
let rect = { x: 0, y: 0, w: 320, h: 80 };

function setStatus(text) {
  statusText.textContent = text;
}

function videoBox() {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(cw / vw, ch / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { x: (cw - width) / 2, y: (ch - height) / 2, width, height, scale };
}

function canvasToVideo(point) {
  const box = videoBox();
  return {
    x: Math.round((point.x - box.x) / box.scale),
    y: Math.round((point.y - box.y) / box.scale)
  };
}

function videoToCanvas(region) {
  const box = videoBox();
  return {
    x: box.x + region.x * box.scale,
    y: box.y + region.y * box.scale,
    w: region.w * box.scale,
    h: region.h * box.scale
  };
}

function paint() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!currentFile) return;
  const r = videoToCanvas(rect);
  ctx.fillStyle = "rgba(20, 122, 114, .22)";
  ctx.strokeStyle = "#27c5b7";
  ctx.lineWidth = 2;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
}

function syncFields() {
  fields.x.value = rect.x;
  fields.y.value = rect.y;
  fields.w.value = rect.w;
  fields.h.value = rect.h;
  paint();
}

function readFields() {
  rect = {
    x: Number(fields.x.value || 0),
    y: Number(fields.y.value || 0),
    w: Number(fields.w.value || 1),
    h: Number(fields.h.value || 1)
  };
  paint();
}

async function upload(file) {
  currentFile = file;
  uploadId = "";
  submit.disabled = true;
  download.hidden = true;
  logs.textContent = "";
  setStatus("上传中");
  emptyState.hidden = true;
  video.src = URL.createObjectURL(file);

  const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    body: file
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "上传失败");
  uploadId = data.uploadId;
  submit.disabled = false;
  setStatus("已上传");
}

function pointFromEvent(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

fileInput.addEventListener("change", event => {
  const file = event.target.files[0];
  if (file) upload(file).catch(error => setStatus(error.message));
});

dropZone.addEventListener("dragover", event => {
  event.preventDefault();
});

dropZone.addEventListener("drop", event => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (file) upload(file).catch(error => setStatus(error.message));
});

canvas.addEventListener("pointerdown", event => {
  if (!currentFile) return;
  canvas.setPointerCapture(event.pointerId);
  dragStart = canvasToVideo(pointFromEvent(event));
});

canvas.addEventListener("pointermove", event => {
  if (!dragStart) return;
  const point = canvasToVideo(pointFromEvent(event));
  rect = {
    x: Math.max(0, Math.min(dragStart.x, point.x)),
    y: Math.max(0, Math.min(dragStart.y, point.y)),
    w: Math.max(1, Math.abs(point.x - dragStart.x)),
    h: Math.max(1, Math.abs(point.y - dragStart.y))
  };
  syncFields();
});

canvas.addEventListener("pointerup", () => {
  dragStart = null;
});

video.addEventListener("loadedmetadata", () => {
  rect = {
    x: Math.round(video.videoWidth * 0.1),
    y: Math.round(video.videoHeight * 0.78),
    w: Math.round(video.videoWidth * 0.8),
    h: Math.round(video.videoHeight * 0.12)
  };
  syncFields();
});

window.addEventListener("resize", paint);
Object.values(fields).forEach(field => field.addEventListener("input", readFields));

submit.addEventListener("click", async () => {
  if (!uploadId) return;
  readFields();
  submit.disabled = true;
  download.hidden = true;
  setStatus("排队中");
  logs.textContent = "";

  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uploadId,
      engine: fields.engine.value,
      options: {
        mode: fields.mode.value,
        regionMode: "manual",
        skipDetection: fields.skipDetection.checked,
        ...rect
      }
    })
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error || "提交失败");
    submit.disabled = false;
    return;
  }
  poll(data.jobId);
});

async function poll(jobId) {
  const response = await fetch(`/api/jobs/${jobId}`);
  const job = await response.json();
  setStatus(job.status === "done" ? "已完成" : job.status === "failed" ? "失败" : "处理中");
  logs.textContent = job.logs || "";
  if (job.status === "done") {
    download.href = job.downloadUrl;
    download.hidden = false;
    submit.disabled = false;
    return;
  }
  if (job.status === "failed") {
    logs.textContent += `\n${job.error || "处理失败"}`;
    submit.disabled = false;
    return;
  }
  setTimeout(() => poll(jobId), 1500);
}
