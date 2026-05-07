const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const { chromium } = require("playwright-core");
const { defaultSettings } = require("../default-config");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, overrides) {
  const next = clone(base);
  const src = overrides || {};

  next.loginUrl = src.loginUrl || next.loginUrl;
  next.formUrl = src.formUrl || next.formUrl;
  if (typeof src.browserChannel === "string") {
    next.browserChannel = src.browserChannel;
  }
  next.headless = typeof src.headless === "boolean" ? src.headless : next.headless;
  next.docsTypeText = src.docsTypeText || next.docsTypeText;
  next.credentials = {
    ...next.credentials,
    ...(src.credentials || {})
  };
  next.fixed = {
    ...next.fixed,
    ...(src.fixed || {})
  };
  next.selectors = {
    ...next.selectors,
    ...(src.selectors || {})
  };
  if (Array.isArray(src.autocompleteSelectors) && src.autocompleteSelectors.length) {
    next.autocompleteSelectors = src.autocompleteSelectors.filter(Boolean);
  }

  return next;
}

function createLogger(log) {
  return {
    info(message) {
      log("info", message);
    },
    warn(message) {
      log("warn", message);
    },
    error(message) {
      log("error", message);
    }
  };
}

function listPatientFolders(baseDir) {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const dirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name));

  if (dirs.length > 0) {
    return dirs;
  }

  const files = fs.readdirSync(baseDir);
  const hasRelevantFiles = files.some((file) => {
    const lower = file.toLowerCase();
    return lower.endsWith(".docx") || lower.endsWith(".pdf");
  });

  return hasRelevantFiles ? [baseDir] : [];
}

function listFilesByExt(dir, exts) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const wanted = new Set(exts.map((ext) => ext.toLowerCase()));
  return fs
    .readdirSync(dir)
    .filter((file) => !file.startsWith("~$"))
    .filter((file) => wanted.has(path.extname(file).toLowerCase()))
    .map((file) => path.join(dir, file));
}

function findPacientePdfMatch(afiliado, patientFolder) {
  const base = String(afiliado || "").trim();
  if (!base || !patientFolder || !fs.existsSync(patientFolder)) {
    return null;
  }

  const files = fs.readdirSync(patientFolder);
  const exactNames = [`${base}.pdf`, `${base}.PDF`, `${base}.pdf.pdf`, `${base}.PDF.PDF`];
  for (const fileName of exactNames) {
    const fullPath = path.join(patientFolder, fileName);
    if (fs.existsSync(fullPath)) {
      return {
        path: fullPath,
        matchType: "exact"
      };
    }
  }

  const startsWith = files.find((file) => {
    return file.toLowerCase().endsWith(".pdf") && file.toLowerCase().startsWith(base.toLowerCase());
  });
  if (startsWith) {
    return {
      path: path.join(patientFolder, startsWith),
      matchType: "prefix"
    };
  }

  const anyPdf = files.find((file) => file.toLowerCase().endsWith(".pdf"));
  return anyPdf
    ? {
        path: path.join(patientFolder, anyPdf),
        matchType: "fallback"
      }
    : null;
}

function findPacientePdf(afiliado, patientFolder) {
  const match = findPacientePdfMatch(afiliado, patientFolder);
  return match ? match.path : null;
}

function pick(text, regex) {
  const match = text.match(regex);
  return match ? (match[1] || "").trim() : "";
}

function digitsOnly(value) {
  return String(value || "").replace(/\D+/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s/+.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordToNumberES(value) {
  const normalized = normalizeText(value).replace(/[+/.-]/g, " ");

  const directNumber = normalized.match(/\b(\d+)\b/);
  if (directNumber) {
    return parseInt(directNumber[1], 10);
  }

  const dictionary = {
    cero: 0,
    un: 1,
    uno: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5
  };

  for (const [key, number] of Object.entries(dictionary)) {
    if (normalized.split(" ").includes(key)) {
      return number;
    }
  }

  return Number.NaN;
}

function parseCantidadAudifonos(text) {
  const safeText = String(text || "").replace(/\u00A0/g, " ");
  const match =
    safeText.match(/cantidad\s*(?:de\s*)?aud[ií]fonos?\s*:\s*([^\r\n]+)/im) ||
    safeText.match(/cant\.?\s*aud[ií]fonos?\s*:\s*([^\r\n]+)/im);

  if (!match) {
    return 1;
  }

  const value = wordToNumberES(match[1] || "");
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  if (value > 2) {
    return 2;
  }
  return value;
}

async function readDocx(file) {
  const { value } = await mammoth.extractRawText({ path: file });
  const text = String(value || "").replace(/\u00A0/g, " ");

  return {
    afiliado: digitsOnly(
      pick(text, /(?:^|\b)AF\b\s*:\s*([0-9][0-9.\s-]+)/im) ||
        pick(text, /(?:^|\b)AFILIADO\b\s*:\s*([0-9][0-9.\s-]+)/im)
    ),
    telefonoArea: digitsOnly(
      pick(text, /(?:^|\b)TelefonoArea\b\s*:\s*([0-9][0-9\s-]*)/im) ||
        pick(text, /(?:^|\b)Tel(?:efono)?\s*Area\b\s*:\s*([0-9][0-9\s-]*)/im)
    ),
    telefono: digitsOnly(
      pick(text, /(?:^|\b)Telefono\b\s*:\s*([0-9][0-9\s-]*)/im) ||
        pick(text, /(?:^|\b)Tel\b\s*:\s*([0-9][0-9\s-]*)/im)
    ),
    ome: digitsOnly(
      pick(text, /(?:^|\b)OME\b\s*:\s*([0-9][0-9.\s-]+)/im) ||
        pick(text, /(?:^|\b)Nro\.?\s*OME\b\s*:\s*([0-9][0-9.\s-]+)/im)
    ),
    cantidadAudifonos: parseCantidadAudifonos(text)
  };
}

async function waitVisibleAny(page, selectors, timeout = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element && (await element.boundingBox())) {
        return selector;
      }
    }
    await sleep(150);
  }
  throw new Error("No apareció el autocomplete del sitio.");
}

async function typeLikeHuman(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.fill(selector, "");
  await page.type(selector, String(value), { delay: 25 });
}

async function pressEnter(page, selector) {
  await page.focus(selector);
  await page.keyboard.press("Enter");
}

async function clickAutocompleteSuggestion(page, selectors, text) {
  const visibleSelector = await waitVisibleAny(page, selectors);
  const items = await page.$$(visibleSelector);
  for (const item of items) {
    const itemText = ((await item.innerText()) || "").trim();
    if (!text || itemText.includes(text)) {
      await item.click();
      return;
    }
  }

  if (!items.length) {
    throw new Error("No hubo opciones para seleccionar en el autocomplete.");
  }

  await items[0].click();
}

async function selectByText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 15000 });
  const selectedText = await page.evaluate(
    ({ selector: cssSelector, text: desiredText }) => {
      const normalize = (value) =>
        String(value || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      const select = document.querySelector(cssSelector);
      if (!select) {
        throw new Error(`No se encontró el select ${cssSelector}`);
      }

      const wanted = normalize(desiredText);
      const option = Array.from(select.options).find((item) => normalize(item.textContent).includes(wanted));
      if (!option) {
        throw new Error(`No se encontró la opción "${desiredText}"`);
      }

      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return option.textContent || "";
    },
    { selector, text }
  );

  return String(selectedText || "").trim();
}

async function selectByBestText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 15000 });
  const timeout = 15000;
  const startedAt = Date.now();
  let lastOptions = [];

  while (Date.now() - startedAt < timeout) {
    const result = await page.evaluate(
      ({ selector: cssSelector, text: desiredText }) => {
        const normalize = (value) =>
          String(value || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\w\s/+.-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const select = document.querySelector(cssSelector);
        if (!select) {
          throw new Error(`No se encontro el select ${cssSelector}`);
        }

        const wanted = normalize(desiredText);
        const desiredTokens = wanted.split(" ").filter((token) => token.length >= 4);
        const options = Array.from(select.options)
          .map((item, index) => ({
            index,
            value: item.value,
            text: String(item.textContent || "").trim(),
            normalized: normalize(item.textContent || "")
          }))
          .filter((item) => item.value && item.normalized);

        const scored = options
          .map((option) => {
            let score = 0;

            if (option.normalized === wanted) {
              score += 5000;
            }

            if (option.normalized.includes(wanted) || wanted.includes(option.normalized)) {
              score += 1000;
            }

            for (const token of desiredTokens) {
              if (option.normalized.includes(token)) {
                score += 20;
              }
            }

            return {
              ...option,
              score
            };
          })
          .sort((a, b) => b.score - a.score || a.index - b.index);

        const best = scored[0] || null;
        const minimumScore = desiredTokens.length > 1 ? 40 : 1000;

        if (!best || best.score < minimumScore) {
          return {
            selectedText: "",
            options: options.map((option) => option.text)
          };
        }

        select.selectedIndex = best.index;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));

        return {
          selectedText: best.text,
          options: options.map((option) => option.text)
        };
      },
      { selector, text }
    );

    lastOptions = result.options || [];
    if (result.selectedText) {
      return String(result.selectedText || "").trim();
    }

    await sleep(250);
  }

  const available = lastOptions.slice(0, 12).join(" | ");
  throw new Error(
    `No se encontro una opcion compatible para "${text}" en ${selector}. Opciones visibles: ${available || "ninguna"}`
  );
}

async function selectDocumentacionOption(page, selector, targetText) {
  await page.waitForSelector(selector, { timeout: 15000 });
  const timeout = 45000;
  const startedAt = Date.now();
  let lastOptions = [];

  while (Date.now() - startedAt < timeout) {
    const result = await page.evaluate(
      ({ selector: cssSelector, text: desiredText }) => {
        const normalize = (value) =>
          String(value || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^\w\s/+.-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const containsAny = (text, needles) => needles.some((needle) => text.includes(needle));

        const select = document.querySelector(cssSelector);
        if (!select) {
          throw new Error(`No se encontro el select ${cssSelector}`);
        }

        const wanted = normalize(desiredText);
        const options = Array.from(select.options)
          .map((option, index) => ({
            index,
            value: option.value,
            text: String(option.textContent || "").trim(),
            normalized: normalize(option.textContent || "")
          }))
          .filter((option) => option.normalized);

        const selectableOptions = options.filter(
          (option) => option.value && !["seleccione", "seleccione."].includes(option.normalized)
        );

        if (!selectableOptions.length) {
          return {
            selectedText: "",
            options: options.map((option) => option.text)
          };
        }

        let choice = selectableOptions.find((option) => option.normalized === wanted);

        if (!choice) {
          const desiredTokens = wanted.split(" ").filter((token) => token.length >= 4);
          const scored = selectableOptions
            .map((option) => {
              let score = 0;

              if (option.normalized.includes(wanted) || wanted.includes(option.normalized)) {
                score += 1000;
              }

              for (const token of desiredTokens) {
                if (option.normalized.includes(token)) {
                  score += 10;
                }
              }

              if (containsAny(option.normalized, ["audiometr"])) {
                score += 80;
              }
              if (containsAny(option.normalized, ["logoaudiometr"])) {
                score += 80;
              }
              if (containsAny(option.normalized, ["timpanometr"])) {
                score += 80;
              }
              if (containsAny(option.normalized, ["impedanciometr"])) {
                score += 80;
              }
              if (containsAny(option.normalized, ["derivacion"])) {
                score += 80;
              }
              if (containsAny(option.normalized, ["orl"])) {
                score += 80;
              }

              return {
                ...option,
                score
              };
            })
            .sort((a, b) => b.score - a.score || a.index - b.index);

          choice = scored[0];
          if (!choice || choice.score < 300) {
            return {
              selectedText: "",
              options: options.map((option) => option.text)
            };
          }
        }

        const expectedTokens = ["audiometr", "logoaudiometr", "timpanometr", "impedanciometr", "derivacion", "orl"];
        if (!expectedTokens.every((token) => choice.normalized.includes(token))) {
          return {
            selectedText: "",
            options: options.map((option) => option.text)
          };
        }

        select.selectedIndex = choice.index;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          selectedText: choice.text,
          options: options.map((option) => option.text)
        };
      },
      { selector, text: targetText }
    );

    lastOptions = result.options || [];
    if (result.selectedText) {
      return String(result.selectedText || "").trim();
    }

    await sleep(250);
  }

  throw new Error(
    `No se encontro una opcion de documentacion utilizable. Opciones visibles: ${
      lastOptions.slice(0, 12).join(" | ") || "ninguna"
    }`
  );
}

async function hasUsableSelectOptions(page, selector) {
  return page.evaluate((cssSelector) => {
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const select = document.querySelector(cssSelector);
    if (!select) {
      return false;
    }

    return Array.from(select.options).some((option) => {
      const text = normalize(option.textContent || "");
      return option.value && text && !["seleccione", "seleccione."].includes(text);
    });
  }, selector);
}

async function waitForUsableSelectOptions(page, selector, timeout = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await hasUsableSelectOptions(page, selector)) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function asegurarNroBeneficio(page) {
  const radios = page.locator('input[type="radio"][name="tipo_busqueda_datos_del_afiliado"]');
  await radios.first().waitFor({ state: "attached", timeout: 15000 });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('input[type="radio"][name="tipo_busqueda_datos_del_afiliado"]')];
      if (items.length < 3) {
        throw new Error("No se encontraron suficientes radios para seleccionar Nro. Beneficio.");
      }

      items.forEach((item) => {
        item.checked = false;
      });

      const radio = items[2];
      radio.checked = true;
      radio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      radio.dispatchEvent(new Event("input", { bubbles: true }));
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.waitForTimeout(120);
    if (await radios.nth(2).isChecked()) {
      return;
    }
  }

  throw new Error("No se pudo fijar la búsqueda por Nro. Beneficio.");
}

async function seleccionarTipoDocumentacion(page, settings) {
  const selector = settings.selectors.documentacionSelect;
  const targetText = settings.docsTypeText;
  const selectedText = await selectByText(page, selector, targetText);
  const normalized = selectedText.toLowerCase();
  if (!normalized.includes("audiometr")) {
    throw new Error(`Se seleccionó una documentación inesperada: "${selectedText}"`);
  }
}

async function subirArchivoDocumentacion(page, filePath) {
  const input = page.locator('input[type="file"]').first();
  if (await input.count()) {
    await input.setInputFiles(filePath);
    const loaded = await page.evaluate(() => {
      const node = document.querySelector('input[type="file"]');
      return Boolean(node && node.files && node.files.length > 0);
    });

    if (loaded) {
      return;
    }
  }

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15000 }),
    page.getByRole("button", { name: /Examinar/i }).click()
  ]);
  await chooser.setFiles(filePath);
}

async function cargarDocumentacionPDF(page, patient, patientFolder, settings) {
  const filePath = findPacientePdf(patient.afiliado, patientFolder);
  if (!filePath) {
    throw new Error(`No se encontró PDF para el afiliado ${patient.afiliado}.`);
  }

  await selectDocumentacionOption(page, settings.selectors.documentacionSelect, settings.docsTypeText);
  await subirArchivoDocumentacion(page, filePath);
  await page.click(settings.selectors.documentacionAgregarBtn);
  await page.waitForTimeout(1200);
}

async function cargarNumeroOME(page, settings, ome) {
  const selector = settings.selectors.omeInput;
  const input = page.locator(selector).first();
  try {
    await input.waitFor({ state: "visible", timeout: 8000 });
  } catch (_error) {
    return false;
  }

  await page.fill(selector, "");
  await page.type(selector, digitsOnly(ome), { delay: 20 });
  await page.evaluate((cssSelector) => {
    const element = document.querySelector(cssSelector);
    if (!element) {
      throw new Error(`No se encontró ${cssSelector}`);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(800);
  return true;
}

async function agregarPractica(page) {
  await page.waitForSelector("#boton_datos_medicos", { timeout: 15000 });
  await page.click("#boton_datos_medicos");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
  await page.waitForTimeout(1200);
}

async function agregarPracticaYEsperarDocumentacion(page, settings) {
  await agregarPractica(page);
  if (await waitForUsableSelectOptions(page, settings.selectors.documentacionSelect, 10000)) {
    return;
  }

  await typeLikeHuman(page, settings.selectors.practicaInput, settings.fixed.practica);
  await pressEnter(page, settings.selectors.practicaInput);
  await clickAutocompleteSuggestion(page, settings.autocompleteSelectors, settings.fixed.practica);
  await agregarPractica(page);
  await waitForUsableSelectOptions(page, settings.selectors.documentacionSelect, 15000);
}

async function generarYVolver(page, settings) {
  const listUrlRegex = /op_panel_listado\.php/i;
  await page.click(settings.selectors.generarBtn);

  try {
    await page.waitForSelector("button.confirm", { timeout: 8000 });
    await page.click("button.confirm");
  } catch (error) {
    if (!/Timeout/.test(String(error))) {
      throw error;
    }
  }

  try {
    await page.waitForURL(listUrlRegex, { timeout: 8000 });
  } catch (error) {
    if (!/Timeout/.test(String(error))) {
      throw error;
    }
  }

  await page.goto(settings.formUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(settings.selectors.postLoginCheck, { timeout: 20000 });
}

async function login(page, settings, logger) {
  logger.info("Iniciando sesión en PAMI...");
  await page.goto(settings.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(settings.selectors.usuarioInput, { timeout: 15000 });
  await page.fill(settings.selectors.usuarioInput, settings.credentials.usuario);
  await page.fill(settings.selectors.passwordInput, settings.credentials.password);

  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }),
    page.click(settings.selectors.loginBtn)
  ]);

  await page.goto(settings.formUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(settings.selectors.postLoginCheck, { timeout: 20000 });
  logger.info("Sesión iniciada correctamente.");
}

async function procesarPaciente(page, patient, patientFolder, settings) {
  await asegurarNroBeneficio(page);
  await typeLikeHuman(page, settings.selectors.afiliadoInput, patient.afiliado);
  await pressEnter(page, settings.selectors.afiliadoInput);
  await clickAutocompleteSuggestion(page, settings.autocompleteSelectors, patient.afiliado);

  if (patient.telefonoArea) {
    await typeLikeHuman(page, settings.selectors.telefonoArea, patient.telefonoArea);
    await pressEnter(page, settings.selectors.telefonoArea);
  }

  if (patient.telefono) {
    await typeLikeHuman(page, settings.selectors.telefonoNumero, patient.telefono);
    await pressEnter(page, settings.selectors.telefonoNumero);
  }

  await selectByBestText(page, settings.selectors.motivoSelect, settings.fixed.motivo);
  await typeLikeHuman(page, settings.selectors.diagnosticoInput, settings.fixed.diagnostico);
  await pressEnter(page, settings.selectors.diagnosticoInput);
  await clickAutocompleteSuggestion(page, settings.autocompleteSelectors, settings.fixed.diagnostico);
  await selectByBestText(page, settings.selectors.modalidadSelect, settings.fixed.modalidad);
  await typeLikeHuman(page, settings.selectors.practicaInput, settings.fixed.practica);
  await pressEnter(page, settings.selectors.practicaInput);
  await clickAutocompleteSuggestion(page, settings.autocompleteSelectors, settings.fixed.practica);
  await agregarPracticaYEsperarDocumentacion(page, settings);

  if (patient.ome) {
    await cargarNumeroOME(page, settings, patient.ome);
  }

  await cargarDocumentacionPDF(page, patient, patientFolder, settings);
  await generarYVolver(page, settings);
}

async function saveErrorScreenshot(page, screenshotsDir, fileName) {
  if (!page || !screenshotsDir) {
    return null;
  }

  fs.mkdirSync(screenshotsDir, { recursive: true });
  const targetPath = path.join(screenshotsDir, fileName);
  await page.screenshot({ path: targetPath, fullPage: true }).catch(() => null);
  return targetPath;
}

function sanitizeSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function resolvePatientsRoot(inputDir) {
  const directFolders = listPatientFolders(inputDir);
  if (directFolders.length !== 1) {
    return inputDir;
  }

  const onlyFolder = directFolders[0];
  const nestedFolders = listPatientFolders(onlyFolder);
  return nestedFolders.length > 0 ? onlyFolder : inputDir;
}

function buildSummary() {
  return {
    folders: 0,
    docx: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
}

function buildInspection() {
  return {
    root: "",
    folders: 0,
    docx: 0,
    validPatients: 0,
    missingPdf: 0,
    fallbackPdf: 0,
    missingAfiliado: 0,
    failedReads: 0,
    estimatedOrders: 0,
    warnings: [],
    patients: []
  };
}

async function inspectPatientsInput(inputDir) {
  const inspection = buildInspection();
  const patientsRoot = resolvePatientsRoot(inputDir);
  inspection.root = patientsRoot;

  const patientFolders = listPatientFolders(patientsRoot);
  inspection.folders = patientFolders.length;

  for (const patientFolder of patientFolders) {
    const folderName = path.basename(patientFolder);
    const docxFiles = listFilesByExt(patientFolder, [".docx"]);

    if (!docxFiles.length) {
      inspection.warnings.push(`No hay archivos .docx en ${folderName}.`);
      continue;
    }

    for (const docxPath of docxFiles) {
      inspection.docx += 1;
      const docName = path.basename(docxPath);

      try {
        const patient = await readDocx(docxPath);
        const hasAfiliado = Boolean(patient.afiliado);
        const pdfMatch = hasAfiliado ? findPacientePdfMatch(patient.afiliado, patientFolder) : null;
        const hasPdf = Boolean(pdfMatch && pdfMatch.path);
        const repetitions = patient.cantidadAudifonos || 1;
        const warnings = [];

        if (!hasAfiliado) {
          inspection.missingAfiliado += 1;
          warnings.push("Falta afiliado en el DOCX.");
        }

        if (!hasPdf) {
          inspection.missingPdf += 1;
          warnings.push("No se encontro PDF para el afiliado detectado.");
        }

        if (pdfMatch && pdfMatch.matchType === "fallback") {
          inspection.fallbackPdf += 1;
          warnings.push("Se usara el unico PDF de la carpeta aunque no coincide por nombre con el afiliado.");
        }

        if (hasAfiliado && hasPdf) {
          inspection.validPatients += 1;
          inspection.estimatedOrders += repetitions;
        }

        inspection.patients.push({
          folder: folderName,
          docx: docName,
          afiliado: patient.afiliado,
          telefonoArea: patient.telefonoArea,
          telefono: patient.telefono,
          ome: patient.ome,
          cantidadAudifonos: repetitions,
          hasPdf,
          pdfName: pdfMatch ? path.basename(pdfMatch.path) : "",
          pdfMatchType: pdfMatch ? pdfMatch.matchType : "",
          status: warnings.length ? "warning" : "ready",
          warnings
        });
      } catch (error) {
        inspection.failedReads += 1;
        inspection.warnings.push(`No se pudo leer ${docName} en ${folderName}: ${error.message}`);
        inspection.patients.push({
          folder: folderName,
          docx: docName,
          afiliado: "",
          telefonoArea: "",
          telefono: "",
          ome: "",
          cantidadAudifonos: 0,
          hasPdf: false,
          pdfName: "",
          status: "error",
          warnings: [error.message]
        });
      }
    }
  }

  return inspection;
}

async function runPamiBot({ rawSettings, inputDir, screenshotsDir, log }) {
  const settings = mergeSettings(defaultSettings, rawSettings);
  const logger = createLogger(log);
  const summary = buildSummary();

  if (!settings.credentials.usuario || !settings.credentials.password) {
    throw new Error("Faltan las credenciales de PAMI.");
  }

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      channel: settings.browserChannel || undefined,
      headless: settings.headless
    });
    context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(20000);

    const patientsRoot = resolvePatientsRoot(inputDir);
    logger.info(`Leyendo pacientes desde ${patientsRoot}`);
    await login(page, settings, logger);

    const patientFolders = listPatientFolders(patientsRoot);
    summary.folders = patientFolders.length;

    if (!patientFolders.length) {
      throw new Error("No se encontraron carpetas ni archivos de pacientes para procesar.");
    }

    for (const patientFolder of patientFolders) {
      const docxFiles = listFilesByExt(patientFolder, [".docx"]);
      if (!docxFiles.length) {
        logger.warn(`No hay archivos .docx en ${path.basename(patientFolder)}. Se omite.`);
        summary.skipped += 1;
        continue;
      }

      for (const docxPath of docxFiles) {
        summary.docx += 1;
        const docName = path.basename(docxPath);
        logger.info(`Procesando ${docName} en ${path.basename(patientFolder)}...`);

        let patient;
        try {
          patient = await readDocx(docxPath);
        } catch (error) {
          summary.failed += 1;
          summary.errors.push(`No se pudo leer ${docName}: ${error.message}`);
          logger.error(`No se pudo leer ${docName}: ${error.message}`);
          continue;
        }

        if (!patient.afiliado) {
          summary.skipped += 1;
          logger.warn(`El archivo ${docName} no contiene afiliado. Se omite.`);
          continue;
        }

        const repetitions = patient.cantidadAudifonos || 1;
        logger.info(`Afiliado ${patient.afiliado}: ${repetitions} carga(s) detectada(s).`);

        for (let index = 1; index <= repetitions; index += 1) {
          try {
            logger.info(`Carga ${index}/${repetitions} para afiliado ${patient.afiliado}.`);
            await page.goto(settings.formUrl, { waitUntil: "domcontentloaded" });
            await procesarPaciente(page, patient, patientFolder, settings);
            summary.generated += 1;
            logger.info(`Orden generada correctamente para ${patient.afiliado}.`);
          } catch (error) {
            summary.failed += 1;
            const safeName = sanitizeSlug(`${patient.afiliado}-${index}`) || `error-${Date.now()}`;
            const screenshotPath = await saveErrorScreenshot(page, screenshotsDir, `${safeName}.png`);
            const details = screenshotPath
              ? `${error.message}. Captura: ${screenshotPath}`
              : error.message;
            summary.errors.push(`Fallo con afiliado ${patient.afiliado}: ${details}`);
            logger.error(`Fallo con afiliado ${patient.afiliado}: ${details}`);
          }
        }
      }
    }
  } finally {
    if (context) {
      await context.close().catch(() => null);
    }
    if (browser) {
      await browser.close().catch(() => null);
    }
  }

  return summary;
}

module.exports = {
  runPamiBot,
  inspectPatientsInput,
  mergeSettings,
  defaultSettings
};
