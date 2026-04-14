const form = document.querySelector("#jobForm");
const runButton = document.querySelector("#runButton");
const inspectButton = document.querySelector("#inspectButton");
const formMessage = document.querySelector("#formMessage");
const logStream = document.querySelector("#logStream");
const jobStatus = document.querySelector("#jobStatus");
const jobId = document.querySelector("#jobId");
const jobSummary = document.querySelector("#jobSummary");
const folderHint = document.querySelector("#folderHint");
const inspectionSummary = document.querySelector("#inspectionSummary");
const inspectionList = document.querySelector("#inspectionList");
const runtimeConfig = window.__PAMI_RUNTIME_CONFIG__ || {};
const apiBaseUrl = String(runtimeConfig.apiBaseUrl || "").replace(/\/+$/, "");

let activeSource = null;
let isRunning = false;
let isInspecting = false;

function apiUrl(path) {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}

function addLog(message, level = "info", at = new Date().toISOString()) {
  const line = document.createElement("p");
  const time = new Date(at).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  line.className = `log-line log-line--${level === "info" ? "ok" : level}`;
  line.textContent = `[${time}] ${message}`;
  logStream.appendChild(line);
  logStream.scrollTop = logStream.scrollHeight;
}

function resetLogs() {
  logStream.innerHTML = "";
}

function syncButtons() {
  runButton.disabled = isRunning || isInspecting;
  inspectButton.disabled = isRunning || isInspecting;
  runButton.textContent = isRunning ? "Ejecutando..." : "Iniciar bot";
  inspectButton.textContent = isInspecting ? "Validando..." : "Validar carpeta";
}

function setBusy(nextRunning) {
  isRunning = nextRunning;
  syncButtons();
}

function setInspecting(nextInspecting) {
  isInspecting = nextInspecting;
  syncButtons();
}

function setSummary(summary, error) {
  if (error) {
    jobSummary.textContent = error;
    return;
  }

  if (!summary) {
    jobSummary.textContent = "Todavia no hay resultados.";
    return;
  }

  jobSummary.textContent =
    `Generadas: ${summary.generated} | Fallidas: ${summary.failed} | Omitidas: ${summary.skipped} | DOCX: ${summary.docx}`;
}

function setStatus(status) {
  const labels = {
    queued: "En cola",
    running: "Ejecutando",
    completed: "Finalizado",
    completed_with_errors: "Finalizado con errores",
    failed: "Fallo"
  };
  jobStatus.textContent = labels[status] || status;
}

function getAdvancedSettings() {
  const raw = document.querySelector("#advancedJson").value.trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function getSelectedFiles() {
  return Array.from(document.querySelector("#patientsFolder").files || []);
}

function clearInspection() {
  inspectionSummary.textContent = "Todavia no validaste la carpeta seleccionada.";
  inspectionList.hidden = true;
  inspectionList.innerHTML = "";
}

function renderInspectionCard(entry) {
  const article = document.createElement("article");
  article.className = `inspection-card inspection-card--${entry.status}`;

  const header = document.createElement("div");
  header.className = "inspection-card__header";

  const title = document.createElement("strong");
  title.textContent = `${entry.folder} / ${entry.docx}`;

  const badge = document.createElement("span");
  badge.className = "inspection-badge";
  badge.textContent = entry.status === "ready" ? "Listo" : entry.status === "warning" ? "Revisar" : "Error";

  header.append(title, badge);
  article.appendChild(header);

  const details = [
    `Afiliado: ${entry.afiliado || "No detectado"}`,
    `OME: ${entry.ome || "Sin dato"}`,
    `Audifonos: ${entry.cantidadAudifonos || 0}`,
    `PDF: ${entry.hasPdf ? entry.pdfName : "No encontrado"}`,
    `Tipo de match PDF: ${entry.pdfMatchType || "sin match"}`
  ];

  details.forEach((text) => {
    const row = document.createElement("p");
    row.className = "inspection-card__meta";
    row.textContent = text;
    article.appendChild(row);
  });

  (entry.warnings || []).forEach((warning) => {
    const row = document.createElement("p");
    row.className = "inspection-card__warning";
    row.textContent = warning;
    article.appendChild(row);
  });

  return article;
}

function renderInspection(result) {
  inspectionSummary.textContent =
    `Carpetas: ${result.folders} | DOCX: ${result.docx} | Listos: ${result.validPatients} | Sin PDF: ${result.missingPdf} | PDF por descarte: ${result.fallbackPdf} | Sin afiliado: ${result.missingAfiliado} | Ordenes estimadas: ${result.estimatedOrders}`;

  inspectionList.innerHTML = "";
  inspectionList.hidden = !result.patients.length;

  result.patients.forEach((entry) => {
    inspectionList.appendChild(renderInspectionCard(entry));
  });

  (result.warnings || []).forEach((warning) => {
    addLog(warning, "warn");
  });
}

function buildSettings() {
  return {
    loginUrl: document.querySelector("#loginUrl").value.trim(),
    formUrl: document.querySelector("#formUrl").value.trim(),
    browserChannel: document.querySelector("#browserChannel").value,
    headless: document.querySelector("#headless").checked,
    docsTypeText: document.querySelector("#docsTypeText").value.trim(),
    credentials: {
      usuario: document.querySelector("#usuario").value.trim(),
      password: document.querySelector("#password").value
    },
    fixed: {
      motivo: document.querySelector("#motivo").value.trim(),
      diagnostico: document.querySelector("#diagnostico").value.trim(),
      practica: document.querySelector("#practica").value.trim(),
      modalidad: document.querySelector("#modalidad").value.trim()
    }
  };
}

function buildUploadBody(files, settings) {
  const body = new FormData();
  body.append("settings", JSON.stringify(settings));
  body.append(
    "relativePaths",
    JSON.stringify(files.map((file) => file.webkitRelativePath || file.name))
  );

  files.forEach((file) => {
    body.append("patients", file, file.name);
  });

  return body;
}

async function loadDefaults() {
  const response = await fetch(apiUrl("/api/default-settings"));
  const defaults = await response.json();

  document.querySelector("#loginUrl").value = defaults.loginUrl;
  document.querySelector("#formUrl").value = defaults.formUrl;
  document.querySelector("#browserChannel").value = defaults.browserChannel;
  document.querySelector("#headless").checked = defaults.headless;
  document.querySelector("#docsTypeText").value = defaults.docsTypeText;
  document.querySelector("#motivo").value = defaults.fixed.motivo;
  document.querySelector("#diagnostico").value = defaults.fixed.diagnostico;
  document.querySelector("#practica").value = defaults.fixed.practica;
  document.querySelector("#modalidad").value = defaults.fixed.modalidad;
  document.querySelector("#advancedJson").value = JSON.stringify(
    {
      selectors: defaults.selectors,
      autocompleteSelectors: defaults.autocompleteSelectors
    },
    null,
    2
  );
}

function connectToStream(id) {
  if (activeSource) {
    activeSource.close();
  }

  activeSource = new EventSource(apiUrl(`/api/jobs/${id}/stream`));

  activeSource.addEventListener("snapshot", (event) => {
    const snapshot = JSON.parse(event.data);
    resetLogs();
    jobId.textContent = snapshot.id;
    setStatus(snapshot.status);
    setSummary(snapshot.summary, snapshot.error);
    (snapshot.logs || []).forEach((entry) => addLog(entry.message, entry.level, entry.at));
    if (snapshot.status !== "running" && snapshot.status !== "queued") {
      setBusy(false);
    }
  });

  activeSource.addEventListener("log", (event) => {
    const entry = JSON.parse(event.data);
    addLog(entry.message, entry.level, entry.at);
  });

  activeSource.addEventListener("status", (event) => {
    const payload = JSON.parse(event.data);
    setStatus(payload.status);
    setSummary(payload.summary, payload.error);
    if (payload.status !== "running" && payload.status !== "queued") {
      setBusy(false);
    }
  });

  activeSource.onerror = () => {
    addLog("Se perdio la conexion con el stream de logs.", "warn");
  };
}

document.querySelector("#patientsFolder").addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  clearInspection();

  if (!files.length) {
    folderHint.textContent = "Selecciona la carpeta raiz que contiene las subcarpetas de cada paciente.";
    return;
  }

  const sample = files[0].webkitRelativePath || files[0].name;
  folderHint.textContent = `Archivos detectados: ${files.length}. Ejemplo: ${sample}`;
});

inspectButton.addEventListener("click", async () => {
  formMessage.textContent = "";

  const files = getSelectedFiles();
  if (!files.length) {
    formMessage.textContent = "Tenes que seleccionar la carpeta de pacientes.";
    return;
  }

  let advanced;
  try {
    advanced = getAdvancedSettings();
  } catch (error) {
    formMessage.textContent = `El JSON avanzado no es valido: ${error.message}`;
    return;
  }

  try {
    setInspecting(true);
    clearInspection();
    addLog("Validando carpeta de pacientes...");

    const response = await fetch(apiUrl("/api/jobs/inspect"), {
      method: "POST",
      body: buildUploadBody(files, { ...buildSettings(), ...advanced })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "No se pudo validar la carpeta.");
    }

    renderInspection(payload);
    addLog("Validacion completada.");
  } catch (error) {
    inspectionSummary.textContent = error.message;
    formMessage.textContent = error.message;
    addLog(error.message, "error");
  } finally {
    setInspecting(false);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "";

  const files = getSelectedFiles();
  if (!files.length) {
    formMessage.textContent = "Tenes que seleccionar la carpeta de pacientes.";
    return;
  }

  let advanced;
  try {
    advanced = getAdvancedSettings();
  } catch (error) {
    formMessage.textContent = `El JSON avanzado no es valido: ${error.message}`;
    return;
  }

  const settings = {
    ...buildSettings(),
    ...advanced
  };

  if (!settings.credentials.usuario || !settings.credentials.password) {
    formMessage.textContent = "Completa usuario y contrasena antes de iniciar el bot.";
    return;
  }

  const body = buildUploadBody(files, settings);

  try {
    setBusy(true);
    resetLogs();
    addLog("Subiendo archivos y preparando la ejecucion...");

    const response = await fetch(apiUrl("/api/jobs/start"), {
      method: "POST",
      body
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "No se pudo iniciar el trabajo.");
    }

    jobId.textContent = payload.id;
    setStatus(payload.status);
    setSummary(null, null);
    addLog("Trabajo creado. Conectando al stream...");
    connectToStream(payload.id);
  } catch (error) {
    setBusy(false);
    formMessage.textContent = error.message;
    addLog(error.message, "error");
  }
});

loadDefaults().catch((error) => {
  formMessage.textContent = `No se pudo cargar la configuracion inicial: ${error.message}`;
});
