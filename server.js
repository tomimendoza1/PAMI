const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { createHmac, randomUUID, timingSafeEqual } = require("crypto");
const { runPamiBot, inspectPatientsInput, defaultSettings } = require("./src/bot/pami-bot");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 35 * 1024 * 1024,
    files: 300
  }
});

const PORT = process.env.PORT || 3000;
const jobs = new Map();
let activeJobId = null;
const AUTH_USERNAME = process.env.PAMI_WEB_USERNAME || process.env.APP_USERNAME || "";
const AUTH_PASSWORD = process.env.PAMI_WEB_PASSWORD || process.env.APP_PASSWORD || "";
const AUTH_ENABLED = Boolean(AUTH_USERNAME && AUTH_PASSWORD);
const AUTH_COOKIE_NAME = "pami_session";
const AUTH_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const AUTH_SECRET = process.env.PAMI_AUTH_SECRET || `${AUTH_USERNAME}:${AUTH_PASSWORD}:pami-web`;
const CORS_ORIGIN_CONFIG = process.env.CORS_ORIGIN || "";

const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, "storage"));
const JOBS_DIR = path.join(STORAGE_DIR, "jobs");
fs.mkdirSync(JOBS_DIR, { recursive: true });

function parseOriginList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => normalizeCorsOrigin(value))
    .filter(Boolean);
}

function normalizeCorsOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\/+$/, "");
}

function getAllowedOrigin(origin) {
  const normalizedOrigin = normalizeCorsOrigin(origin);
  if (!normalizedOrigin) {
    return null;
  }

  const allowedOrigins = parseOriginList(CORS_ORIGIN_CONFIG);
  if (!allowedOrigins.length) {
    return normalizedOrigin;
  }

  if (allowedOrigins.includes("*")) {
    return normalizedOrigin;
  }

  return allowedOrigins.includes(normalizedOrigin) ? normalizedOrigin : null;
}

function appendCorsHeaders(req, res) {
  const allowedOrigin = getAllowedOrigin(req.headers.origin);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex < 0) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value) {
  return createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

function createSessionCookieValue(username) {
  const payload = toBase64Url(
    JSON.stringify({
      username,
      exp: Date.now() + AUTH_SESSION_TTL_MS
    })
  );
  const signature = signValue(payload);
  return `${payload}.${signature}`;
}

function verifySessionCookieValue(value) {
  if (!value || !AUTH_ENABLED) {
    return null;
  }

  const [payload, signature] = String(value).split(".");
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signValue(payload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payload));
    if (!parsed || parsed.username !== AUTH_USERNAME || Number(parsed.exp) <= Date.now()) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  if (req.query && typeof req.query.auth === "string" && req.query.auth.trim()) {
    return req.query.auth.trim();
  }

  return "";
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) {
    return true;
  }

  const bearerToken = extractBearerToken(req);
  if (verifySessionCookieValue(bearerToken)) {
    return true;
  }

  const cookies = parseCookies(req);
  return Boolean(verifySessionCookieValue(cookies[AUTH_COOKIE_NAME]));
}

function buildCookieOptions() {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = process.env.PAMI_AUTH_SAME_SITE || (process.env.CORS_ORIGIN ? "None" : "Lax");
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`,
    `SameSite=${sameSite}`
  ];

  if (secure || String(sameSite).toLowerCase() === "none") {
    parts.push("Secure");
  }

  return parts;
}

function setSessionCookie(res, value) {
  const parts = buildCookieOptions();
  parts[0] = `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`;
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = buildCookieOptions();
  parts[0] = `${AUTH_COOKIE_NAME}=`;
  parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  return res.status(401).json({
    error: "Sesion requerida.",
    code: "AUTH_REQUIRED"
  });
}

function sendNoStoreJson(res, payload) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.json(payload);
}

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
app.use((req, res, next) => {
  appendCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  sendNoStoreJson(res, {
    ok: true,
    activeJobId
  });
});

app.get("/api/auth/status", (req, res) => {
  sendNoStoreJson(res, {
    enabled: AUTH_ENABLED,
    authenticated: isAuthenticated(req)
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!AUTH_ENABLED) {
    return sendNoStoreJson(res, {
      enabled: false,
      authenticated: true
    });
  }

  const { username = "", password = "" } = req.body || {};
  if (username !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
    clearSessionCookie(res);
    return res.status(401).json({
      error: "Usuario o contrasena incorrectos.",
      code: "INVALID_CREDENTIALS"
    });
  }

  const token = createSessionCookieValue(username);
  setSessionCookie(res, token);
  return sendNoStoreJson(res, {
    enabled: true,
    authenticated: true,
    token
  });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  sendNoStoreJson(res, {
    ok: true
  });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/auth/")) {
    return next();
  }
  return requireAuth(req, res, next);
});

app.get("/api/default-settings", (_req, res) => {
  sendNoStoreJson(res, defaultSettings);
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

app.use((error, _req, res, next) => {
  if (!error) {
    return next();
  }

  if (error instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "Uno de los archivos supera el limite de 35 MB.",
      LIMIT_FILE_COUNT: "La carpeta supera el limite de 300 archivos.",
      LIMIT_UNEXPECTED_FILE: "La carga contiene un campo de archivo inesperado."
    };

    return res.status(413).json({
      error: messages[error.code] || `No se pudo recibir la carga: ${error.message}`
    });
  }

  console.error("Error no controlado:", error);
  return res.status(500).json({
    error: error.message || "Error interno del servidor."
  });
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
