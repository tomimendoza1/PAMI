const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { runPamiBot, inspectPatientsInput, defaultSettings } = require("./src/bot/pami-bot");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 35 * 1024 * 1024,
    files: 300
  }
});

const PORT = process.env.PORT || 3001;
const jobs = new Map();
let activeJobId = null;

const STORAGE_DIR = path.join(__dirname, "storage");
const JOBS_DIR = path.join(STORAGE_DIR, "jobs");
fs.mkdirSync(JOBS_DIR, { recursive: true });

function sanitizeRelativePath(relativePath) {
  const normalized = path.normalize(String(relativePath || "").replace(/^([/\\]+)/, ""));
  if (!normalized || normalized === "." || normalized.includes("..")) {
    throw new Error(`Ruta invalida recibida: ${relativePath}`);
  }
  return normalized;
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createJob(rawSettings) {
  const id = randomUUID();
  const dir = path.join(JOBS_DIR, id);
  const inputDir = path.join(dir, "input");
  const screenshotsDir = path.join(dir, "screenshots");
  fs.mkdirSync(inputDir, { recursive: true });

  const job = {
    id,
    dir,
    inputDir,
    screenshotsDir,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    status: "queued",
    rawSettings,
    logs: [],
    summary: null,
    error: null,
    subscribers: new Set()
  };

  jobs.set(id, job);
  return job;
}

function broadcast(job, event, data) {
  for (const subscriber of job.subscribers) {
    sendEvent(subscriber, event, data);
  }
}

function appendLog(job, level, message) {
  const entry = {
    level,
    message,
    at: new Date().toISOString()
  };

  job.logs.push(entry);
  broadcast(job, "log", entry);

  const print = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  print(`[${job.id}] ${message}`);
}

function updateStatus(job, status, extra = {}) {
  job.status = status;
  Object.assign(job, extra);
  broadcast(job, "status", {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error: job.error
  });
}

function writeUploadedFiles(job, files, relativePaths) {
  files.forEach((file, index) => {
    const rawRelativePath = relativePaths[index] || file.originalname;
    const relativePath = sanitizeRelativePath(rawRelativePath);
    const targetPath = path.join(job.inputDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, file.buffer);
  });
}

function readJsonField(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return JSON.parse(value);
}

function parseUploadPayload(req) {
  const files = req.files || [];
  if (!files.length) {
    throw new Error("Subi al menos un archivo de pacientes.");
  }

  const rawSettings = readJsonField(req.body.settings, {});
  const relativePaths = readJsonField(req.body.relativePaths, []);

  if (!Array.isArray(relativePaths)) {
    throw new Error("La lista de rutas relativas no tiene un formato valido.");
  }

  if (relativePaths.length && relativePaths.length !== files.length) {
    throw new Error("La lista de rutas relativas no coincide con los archivos recibidos.");
  }

  return {
    files,
    rawSettings,
    relativePaths
  };
}

async function executeJob(job) {
  activeJobId = job.id;
  job.startedAt = new Date().toISOString();
  updateStatus(job, "running");

  try {
    const summary = await runPamiBot({
      rawSettings: job.rawSettings,
      inputDir: job.inputDir,
      screenshotsDir: job.screenshotsDir,
      log: (level, message) => appendLog(job, level, message)
    });

    job.summary = summary;
    job.finishedAt = new Date().toISOString();
    updateStatus(job, summary.failed > 0 ? "completed_with_errors" : "completed");
  } catch (error) {
    job.error = error.message;
    job.finishedAt = new Date().toISOString();
    appendLog(job, "error", error.message);
    updateStatus(job, "failed");
  } finally {
    activeJobId = null;
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    activeJobId
  });
});

app.get("/api/default-settings", (_req, res) => {
  res.json(defaultSettings);
});

app.post("/api/jobs/inspect", upload.any(), async (req, res) => {
  let tempDir = null;

  try {
    const { files, relativePaths } = parseUploadPayload(req);
    tempDir = path.join(STORAGE_DIR, `inspect-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    writeUploadedFiles({ inputDir: tempDir }, files, relativePaths);

    const inspection = await inspectPatientsInput(tempDir);
    return res.json(inspection);
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo validar la carpeta." });
  } finally {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Trabajo no encontrado." });
  }

  return res.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error: job.error,
    logs: job.logs
  });
});

app.get("/api/jobs/:id/stream", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  job.subscribers.add(res);
  sendEvent(res, "snapshot", {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    summary: job.summary,
    error: job.error,
    logs: job.logs
  });

  req.on("close", () => {
    job.subscribers.delete(res);
  });
});

app.post("/api/jobs/start", upload.any(), async (req, res) => {
  if (activeJobId) {
    return res.status(409).json({
      error: "Ya hay una ejecucion en curso. Espera a que termine antes de iniciar otra."
    });
  }

  let files;
  let rawSettings;
  let relativePaths;

  try {
    ({ files, rawSettings, relativePaths } = parseUploadPayload(req));
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo interpretar la carga." });
  }

  try {
    const job = createJob(rawSettings);
    writeUploadedFiles(job, files, relativePaths);
    appendLog(job, "info", `Archivos recibidos: ${files.length}`);
    res.status(202).json({ id: job.id, status: job.status });
    setImmediate(() => {
      executeJob(job).catch((error) => {
        appendLog(job, "error", error.message);
        updateStatus(job, "failed", {
          finishedAt: new Date().toISOString(),
          error: error.message
        });
        activeJobId = null;
      });
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "No se pudo iniciar el trabajo." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`PAMI Bot Web disponible en http://localhost:${PORT}`);
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(
      `No se pudo iniciar PAMI Bot Web porque el puerto ${PORT} ya esta en uso. Cerra la otra instancia o defini PORT con otro valor.`
    );
    process.exit(1);
  }

  console.error("No se pudo iniciar el servidor:", error);
  process.exit(1);
});
