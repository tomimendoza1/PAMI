const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const { chromium } = require("playwright-core");
const { defaultSettings } = require("../default-config");

const TIMEOUTS = {
  defaultAction: 6000,
  shortAction: 2000,
  selector: 4000,
  loginNavigation: 30000,
  loginPageLoad: 30000,
  pageLoad: 20000,
  formReady: 20000,
  afiliadoInput: 10000,
  afiliadoAutocomplete: 6000,
  autocomplete: 1500,
  autocompleteQuick: 900,
  practicaAutocomplete: 6000,
  documentacionOptions: 8000,
  documentacionReady: 2500,
  documentacionButton: 8000,
  fileChooser: 6000,
  networkIdle: 1500,
  confirmation: 2500,
  generar: 30000,
  datosMedicosButton: 1000,
  datosMedicosClick: 1500,
  omeInput: 1500,
  bodyText: 500
};

const PAUSES = {
  poll: 100,
  short: 120,
  afterRadio: 60,
  afterFileAdd: 400,
  afterOme: 250,
  afterPracticeAdd: 400
};

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
  if (typeof src.timezoneId === "string" && src.timezoneId.trim()) {
    next.timezoneId = src.timezoneId.trim();
  }
  if (typeof src.locale === "string" && src.locale.trim()) {
    next.locale = src.locale.trim();
  }
  next.headless = typeof src.headless === "boolean" ? src.headless : next.headless;
  next.debugScreenshots = typeof src.debugScreenshots === "boolean" ? src.debugScreenshots : next.debugScreenshots;
  next.recordVideo = typeof src.recordVideo === "boolean" ? src.recordVideo : next.recordVideo;
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

function getBrowserLaunchOptions(settings, logger) {
  const mustRunHeadless = process.platform !== "win32" && !process.env.DISPLAY;
  if (mustRunHeadless && !settings.headless) {
    logger.warn("Modo visible desactivado automaticamente: el servidor Linux no tiene pantalla grafica. Se usara headless.");
  }

  return {
    channel: settings.browserChannel || undefined,
    headless: mustRunHeadless ? true : settings.headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  };
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

function createCancelError() {
  const error = new Error("Ejecucion cancelada por el usuario.");
  error.code = "JOB_CANCELLED";
  return error;
}

function throwIfCancelled(signal) {
  if (signal && signal.cancelled) {
    throw createCancelError();
  }
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

function parsePhoneFields(text) {
  const safeText = String(text || "")
    .replace(/\u00A0/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  let telefonoArea = digitsOnly(
    pick(safeText, /(?:^|\b)(?:telefono\s*)?area\b\s*:?\s*([0-9][0-9\s-]*)/im) ||
      pick(safeText, /(?:^|\b)cod(?:igo)?\.?\s*(?:de\s*)?area\b\s*:?\s*([0-9][0-9\s-]*)/im)
  );

  let telefono = digitsOnly(
    pick(safeText, /(?:^|\b)telefono\b(?!\s*area)\s*:?\s*([0-9][0-9\s-]*)/im) ||
      pick(safeText, /(?:^|\b)tel\b(?!\s*area)\s*:?\s*([0-9][0-9\s-]*)/im)
  );

  if (!telefonoArea && telefono.length > 2) {
    telefonoArea = telefono.slice(0, 2);
    telefono = telefono.slice(2);
  }

  if (telefonoArea.length > 2 && !telefono) {
    telefono = telefonoArea.slice(2);
    telefonoArea = telefonoArea.slice(0, 2);
  }

  return {
    telefonoArea,
    telefono
  };
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
  const phone = parsePhoneFields(text);

  return {
    afiliado: digitsOnly(
      pick(text, /(?:^|\b)AF\b\s*:\s*([0-9][0-9.\s-]+)/im) ||
        pick(text, /(?:^|\b)AFILIADO\b\s*:\s*([0-9][0-9.\s-]+)/im)
    ),
    telefonoArea: phone.telefonoArea,
    telefono: phone.telefono,
    ome: digitsOnly(
      pick(text, /(?:^|\b)OME\b\s*:\s*([0-9][0-9.\s-]+)/im) ||
        pick(text, /(?:^|\b)Nro\.?\s*OME\b\s*:\s*([0-9][0-9.\s-]+)/im)
    ),
    cantidadAudifonos: parseCantidadAudifonos(text)
  };
}

async function getVisibleAutocompleteItems(page, selectors) {
  const handles = [];
  for (const selector of selectors) {
    const items = await page.$$(selector);
    for (const item of items) {
      const visible = await item
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .catch(() => false);
      if (visible) {
        handles.push(item);
      }
    }
  }
  return handles;
}

async function waitVisibleAutocompleteItems(page, selectors, timeout = TIMEOUTS.autocomplete) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const items = await getVisibleAutocompleteItems(page, selectors);
    if (items.length) {
      return items;
    }
    await sleep(PAUSES.poll);
  }
  throw new Error("No apareció el autocomplete del sitio.");
}

async function typeLikeHuman(page, selector, value) {
  await page.waitForSelector(selector, { timeout: TIMEOUTS.selector });
  await page.fill(selector, "");
  await page.type(selector, String(value), { delay: 10 });
}

async function closeAutocompleteMenus(page) {
  await page.keyboard.press("Escape").catch(() => null);
  await page.mouse.click(1, 1).catch(() => null);
}

async function dismissAutocompleteMenus(page) {
  await page.keyboard.press("Escape").catch(() => null);
}

async function waitForEditableInput(page, selector, timeout = TIMEOUTS.selector) {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const ready = await input
      .evaluate((element) => {
        return !element.disabled && !element.readOnly && element.offsetParent !== null;
      })
      .catch(() => false);

    if (ready) {
      return;
    }

    await sleep(PAUSES.short);
  }

  throw new Error(`El campo ${selector} no quedo listo para escribir.`);
}

async function clickLoginButton(page, settings) {
  await page.evaluate((selectors) => {
    for (const selector of [selectors.usuarioInput, selectors.passwordInput]) {
      const element = document.querySelector(selector);
      if (!element) {
        continue;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }, settings.selectors);

  const button = page.locator(settings.selectors.loginBtn).first();
  await button.waitFor({ state: "visible", timeout: TIMEOUTS.selector });

  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUTS.loginNavigation) {
    if (await button.isEnabled().catch(() => false)) {
      const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: TIMEOUTS.loginNavigation }).catch(() => null);
      await button.click({ timeout: TIMEOUTS.shortAction });
      await navigation;
      return;
    }

    await sleep(PAUSES.short);
  }

  throw new Error("El boton Ingresar no quedo habilitado para iniciar sesion.");
}

async function pressEnter(page, selector) {
  await page.focus(selector);
  await page.keyboard.press("Enter");
}

async function clickAutocompleteSuggestion(page, selectors, text, timeout = TIMEOUTS.autocomplete) {
  const items = await waitVisibleAutocompleteItems(page, selectors, timeout);
  for (const item of items) {
    const itemText = ((await item.innerText()) || "").trim();
    if (!text || itemText.includes(text)) {
      await item.evaluate((element) => {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      });
      return;
    }
  }

  if (!items.length) {
    throw new Error("No hubo opciones para seleccionar en el autocomplete.");
  }

  await items[0].evaluate((element) => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
}

async function clickExactAutocompleteSuggestion(page, selectors, text, timeout = TIMEOUTS.autocomplete) {
  const items = await waitVisibleAutocompleteItems(page, selectors, timeout);
  for (const item of items) {
    const itemText = ((await item.innerText()) || "").trim();
    const itemDigits = digitsOnly(itemText);
    if (itemText.includes(text) || itemDigits.includes(text)) {
      await item.evaluate((element) => {
        element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      });
      return;
    }
  }

  throw new Error(`No se encontro "${text}" en el autocomplete.`);
}

function buildAfiliadoSearchCandidates(afiliado) {
  const base = String(afiliado || "").trim();
  if (base.length <= 2) {
    return [base].filter(Boolean);
  }

  const withoutLastTwoDigits = base.slice(0, -2);
  return [...new Set([base, withoutLastTwoDigits].filter(Boolean))];
}

async function buscarYSeleccionarAfiliado(page, settings, patient, logger) {
  const candidates = buildAfiliadoSearchCandidates(patient.afiliado);
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      await waitForEditableInput(page, settings.selectors.afiliadoInput, TIMEOUTS.afiliadoInput);
      await typeLikeHuman(page, settings.selectors.afiliadoInput, candidate);
      await pressEnter(page, settings.selectors.afiliadoInput);
      await clickAutocompleteSuggestion(page, settings.autocompleteSelectors, candidate, TIMEOUTS.afiliadoAutocomplete);

      if (candidate !== patient.afiliado) {
        logger.warn(`Afiliado ${patient.afiliado} no encontrado; se selecciono ${candidate} quitando los ultimos dos digitos.`);
      }

      return candidate;
    } catch (error) {
      lastError = error;
      if (index < candidates.length - 1) {
        logger.warn(`No se encontro afiliado ${candidate}. Reintentando sin los ultimos dos digitos.`);
      }
    }
  }

  throw lastError || new Error(`No se pudo seleccionar afiliado ${patient.afiliado}.`);
}

async function acceptAutocompleteOrKeepTypedValue(page, selector, selectors, text, timeout = TIMEOUTS.autocompleteQuick) {
  await dismissAutocompleteMenus(page);
  await pressEnter(page, selector);

  try {
    await clickAutocompleteSuggestion(page, selectors, text, timeout);
    await closeAutocompleteMenus(page);
    return;
  } catch (error) {
    if (!String(error.message || error).includes("autocomplete")) {
      throw error;
    }
  }

  const value = await page.locator(selector).first().inputValue().catch(() => "");
  if (!String(value || "").trim()) {
    throw new Error(`No se pudo confirmar el valor "${text}" en ${selector}.`);
  }
}

async function selectRequiredAutocomplete(page, selector, selectors, text, timeout) {
  await dismissAutocompleteMenus(page);
  await page.locator(selector).first().focus();
  await pressEnter(page, selector);
  await clickAutocompleteSuggestion(page, selectors, text, timeout);
  await page.locator(selector).first().blur().catch(() => null);
  await closeAutocompleteMenus(page);
}

async function refreshMedicalDataFields(page, settings) {
  await page.evaluate((selectors) => {
    const dispatch = (element) => {
      if (!element) {
        return;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    dispatch(document.querySelector(selectors.diagnosticoInput));
    dispatch(document.querySelector(selectors.modalidadSelect));
    dispatch(document.querySelector(selectors.practicaInput));
  }, settings.selectors);
}

async function getMedicalDataDiagnostic(page, settings) {
  return page.evaluate((selectors) => {
    const readInput = (selector) => {
      const element = document.querySelector(selector);
      return element ? String(element.value || "").trim() : "";
    };
    const readSelect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return "";
      }
      const option = element.options[element.selectedIndex];
      return option ? String(option.textContent || "").trim() : String(element.value || "").trim();
    };
    const button = document.querySelector("#boton_datos_medicos");

    return {
      diagnostico: readInput(selectors.diagnosticoInput),
      modalidad: readSelect(selectors.modalidadSelect),
      practica: readInput(selectors.practicaInput),
      botonAgregar: button
        ? {
            disabled: Boolean(button.disabled),
            text: String(button.textContent || "").replace(/\s+/g, " ").trim()
          }
        : null
    };
  }, settings.selectors);
}

function formatMedicalDataDiagnostic(diagnostic) {
  if (!diagnostic) {
    return "sin diagnostico disponible";
  }

  const button = diagnostic.botonAgregar
    ? `boton="${diagnostic.botonAgregar.text || "sin texto"}", disabled=${diagnostic.botonAgregar.disabled}`
    : "boton no encontrado";

  return [
    `diagnostico="${diagnostic.diagnostico || ""}"`,
    `modalidad="${diagnostic.modalidad || ""}"`,
    `practica="${diagnostic.practica || ""}"`,
    button
  ].join(" | ");
}

async function selectByText(page, selector, text) {
  await page.waitForSelector(selector, { timeout: TIMEOUTS.selector });
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
  await page.waitForSelector(selector, { timeout: TIMEOUTS.selector });
  const timeout = TIMEOUTS.selector;
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

    await sleep(PAUSES.poll);
  }

  const available = lastOptions.slice(0, 12).join(" | ");
  throw new Error(
    `No se encontro una opcion compatible para "${text}" en ${selector}. Opciones visibles: ${available || "ninguna"}`
  );
}

async function selectDocumentacionOption(page, selector, targetText) {
  await page.waitForSelector(selector, { timeout: TIMEOUTS.selector });
  const timeout = TIMEOUTS.documentacionOptions;
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

    await sleep(PAUSES.short);
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

async function waitForUsableSelectOptions(page, selector, timeout = TIMEOUTS.documentacionReady) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await hasUsableSelectOptions(page, selector)) {
      return true;
    }
    await sleep(PAUSES.short);
  }
  return false;
}

async function getPageDiagnostic(page) {
  const currentUrl = page.url();
  const title = await page.title().catch(() => "");
  const loginVisible = await page.locator("#c_usuario, #password, #ingresar").first().isVisible().catch(() => false);
  const bodyText = await page.locator("body").innerText({ timeout: TIMEOUTS.bodyText }).catch(() => "");
  const compactText = bodyText.replace(/\s+/g, " ").trim().slice(0, 300);

  return [
    `URL actual: ${currentUrl || "desconocida"}`,
    title ? `Titulo: ${title}` : "",
    loginVisible ? "La pantalla de login sigue visible; revisa usuario, contrasena o permisos de PAMI." : "",
    compactText ? `Texto visible: ${compactText}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

async function getPamiAccessBlocker(page) {
  const bodyText = await page.locator("body").innerText({ timeout: TIMEOUTS.bodyText }).catch(() => "");
  const normalized = normalizeText(bodyText);

  if (normalized.includes("no tiene permisos") || normalized.includes("sesion ha expirado")) {
    return bodyText.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  return "";
}

async function throwPamiFormError(page, options = {}) {
  const screenshotName = sanitizeSlug(options.screenshotName || "formulario-pami-no-disponible") || `formulario-${Date.now()}`;
  const screenshotPath = options.screenshotsDir
    ? await saveErrorScreenshot(page, options.screenshotsDir, `${screenshotName}.png`)
    : null;
  if (screenshotPath && options.logger) {
    options.logger.error(`Captura del error de formulario PAMI: ${screenshotPath}`);
  }

  const diagnostic = await getPageDiagnostic(page);
  const details = screenshotPath ? `${diagnostic} | Captura: ${screenshotPath}` : diagnostic;
  const error = new Error(`No se encontro el formulario de carga de PAMI despues de iniciar sesion. ${details}`);
  if (await getPamiAccessBlocker(page)) {
    error.code = "PAMI_SESSION_BLOCKED";
  }
  throw error;
}

async function waitForPamiForm(page, settings, options = {}) {
  const timeout = typeof options === "number" ? options : options.timeout || TIMEOUTS.formReady;
  const errorOptions =
    typeof options === "number"
      ? {}
      : {
          screenshotsDir: options.screenshotsDir,
          logger: options.logger,
          screenshotName: options.screenshotName
        };
  const selectors = [
    settings.selectors.postLoginCheck,
    settings.selectors.afiliadoInput,
    'input[name="tipo_busqueda_datos_del_afiliado"]',
    settings.selectors.motivoSelect
  ].filter(Boolean);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    for (const selector of selectors) {
      if (await page.locator(selector).first().count().catch(() => 0)) {
        return selector;
      }
    }
    if (await getPamiAccessBlocker(page)) {
      await throwPamiFormError(page, errorOptions);
    }
    await sleep(PAUSES.short);
  }

  await throwPamiFormError(page, errorOptions);
}

async function abrirFormularioNuevo(page, settings, options = {}) {
  await closeAutocompleteMenus(page);
  await page.goto(settings.formUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.pageLoad });
  await waitForPamiForm(page, settings, options);
  await closeAutocompleteMenus(page);
}

async function asegurarNroBeneficio(page) {
  const radios = page.locator('input[type="radio"][name="tipo_busqueda_datos_del_afiliado"]');
  await radios.first().waitFor({ state: "attached", timeout: TIMEOUTS.selector });

  for (let attempt = 0; attempt < 8; attempt += 1) {
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

    await page.waitForTimeout(PAUSES.afterRadio);
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
      if (!node || !node.files || !node.files.length) {
        return false;
      }
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      node.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    });

    if (loaded) {
      return;
    }
  }

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: TIMEOUTS.fileChooser }),
    page.getByRole("button", { name: /Examinar/i }).click()
  ]);
  await chooser.setFiles(filePath);
}

async function refreshDocumentacionFields(page, settings) {
  await page.evaluate((selectors) => {
    const dispatch = (element) => {
      if (!element) {
        return;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    dispatch(document.querySelector(selectors.documentacionSelect));
    dispatch(document.querySelector('input[type="file"]'));
  }, settings.selectors);
}

async function getDocumentacionDiagnostic(page, settings) {
  return page.evaluate((selectors) => {
    const select = document.querySelector(selectors.documentacionSelect);
    const option = select && select.options ? select.options[select.selectedIndex] : null;
    const input = document.querySelector('input[type="file"]');
    const button = document.querySelector(selectors.documentacionAgregarBtn);

    return {
      tipo: option ? String(option.textContent || "").trim() : "",
      archivo: input && input.files && input.files.length ? input.files[0].name : "",
      botonAgregar: button
        ? {
            disabled: Boolean(button.disabled),
            text: String(button.textContent || "").replace(/\s+/g, " ").trim()
          }
        : null
    };
  }, settings.selectors);
}

function formatDocumentacionDiagnostic(diagnostic) {
  if (!diagnostic) {
    return "sin diagnostico disponible";
  }

  const button = diagnostic.botonAgregar
    ? `boton="${diagnostic.botonAgregar.text || "sin texto"}", disabled=${diagnostic.botonAgregar.disabled}`
    : "boton no encontrado";

  return [`tipo="${diagnostic.tipo || ""}"`, `archivo="${diagnostic.archivo || ""}"`, button].join(" | ");
}

async function waitForDocumentacionAgregarEnabled(page, settings, timeout = TIMEOUTS.documentacionButton) {
  const button = page.locator(settings.selectors.documentacionAgregarBtn).first();
  await button.waitFor({ state: "visible", timeout: TIMEOUTS.selector });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await button.isEnabled().catch(() => false)) {
      return true;
    }

    await refreshDocumentacionFields(page, settings).catch(() => null);
    await sleep(PAUSES.short);
  }

  return false;
}

async function cargarDocumentacionPDF(page, patient, patientFolder, settings) {
  const filePath = findPacientePdf(patient.afiliado, patientFolder);
  if (!filePath) {
    throw new Error(`No se encontró PDF para el afiliado ${patient.afiliado}.`);
  }

  await selectDocumentacionOption(page, settings.selectors.documentacionSelect, settings.docsTypeText);
  await subirArchivoDocumentacion(page, filePath);
  await refreshDocumentacionFields(page, settings);
  if (!(await waitForDocumentacionAgregarEnabled(page, settings))) {
    const details = formatDocumentacionDiagnostic(await getDocumentacionDiagnostic(page, settings).catch(() => null));
    throw new Error(`No se pudo agregar la documentacion. Estado final: ${details}`);
  }

  await page.click(settings.selectors.documentacionAgregarBtn, { timeout: TIMEOUTS.shortAction });
  await page.waitForTimeout(PAUSES.afterFileAdd);
}

async function cargarNumeroOME(page, settings, ome) {
  const selector = settings.selectors.omeInput;
  const input = page.locator(selector).first();
  try {
    await input.waitFor({ state: "visible", timeout: TIMEOUTS.omeInput });
  } catch (_error) {
    return false;
  }

  await page.fill(selector, "");
  await page.type(selector, digitsOnly(ome), { delay: 10 });
  await page.evaluate((cssSelector) => {
    const element = document.querySelector(cssSelector);
    if (!element) {
      throw new Error(`No se encontró ${cssSelector}`);
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector);
  await page.waitForLoadState("networkidle", { timeout: TIMEOUTS.networkIdle }).catch(() => null);
  await page.waitForTimeout(PAUSES.afterOme);
  return true;
}

async function waitForDatosMedicosEnabled(page, settings, timeout = TIMEOUTS.datosMedicosButton) {
  const button = page.locator("#boton_datos_medicos").first();
  await button.waitFor({ state: "visible", timeout: TIMEOUTS.selector });
  await button.scrollIntoViewIfNeeded();
  const startedAt = Date.now();
  let autocompleteRetried = false;

  while (Date.now() - startedAt < timeout) {
    if (await button.isEnabled().catch(() => false)) {
      return true;
    }

    if (!autocompleteRetried) {
      autocompleteRetried = true;
      await clickExactAutocompleteSuggestion(
        page,
        settings.autocompleteSelectors,
        settings.fixed.practica,
        TIMEOUTS.autocompleteQuick
      ).catch(() => null);
    }

    await refreshMedicalDataFields(page, settings).catch(() => null);
    await sleep(PAUSES.poll);
  }

  return false;
}

async function agregarPractica(page, settings) {
  await page.waitForSelector("#boton_datos_medicos", { timeout: TIMEOUTS.selector });
  await page.click("#boton_datos_medicos", { timeout: TIMEOUTS.datosMedicosClick });
  await page.waitForTimeout(800);
  return true;
}

async function agregarPracticaYEsperarDocumentacion(page, settings) {
  await agregarPractica(page, settings);
  if (!(await waitForUsableSelectOptions(page, settings.selectors.documentacionSelect))) {
    const details = formatMedicalDataDiagnostic(await getMedicalDataDiagnostic(page, settings).catch(() => null));
    throw new Error(`No se habilito documentacion despues de presionar Agregar en Datos Medicos. Estado final: ${details}`);
  }
}

async function captureDebugScreenshot(page, settings, screenshotsDir, logger, label, fileName) {
  if (!settings.debugScreenshots || !page || !screenshotsDir) {
    return;
  }

  const safeName = sanitizeSlug(fileName || label) || `captura-${Date.now()}`;
  const screenshotPath = await saveErrorScreenshot(page, screenshotsDir, `${safeName}.png`);
  if (screenshotPath) {
    logger.info(`${label}. Captura: ${screenshotPath}`);
  }
}

async function isPamiLoading(page) {
  return page.evaluate(() => {
    const text = String(document.body ? document.body.innerText || "" : "").replace(/\s+/g, " ");
    return /Cargando\.?\s+Por favor espere/i.test(text);
  }).catch(() => false);
}

async function waitForPamiLoadingToFinish(page, timeout = TIMEOUTS.generar) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (!(await isPamiLoading(page))) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function generarYVolver(page, settings, screenshotsDir, logger, capturePrefix) {
  const listUrlRegex = /op_panel_listado\.php/i;
  await page.click(settings.selectors.generarBtn, { timeout: TIMEOUTS.shortAction });
  await captureDebugScreenshot(
    page,
    settings,
    screenshotsDir,
    logger,
    "Pantalla despues de presionar Generar",
    `${capturePrefix}-05-generar`
  );

  const loadingFinished = await waitForPamiLoadingToFinish(page, TIMEOUTS.generar);
  if (!loadingFinished) {
    throw new Error("PAMI quedo cargando despues de presionar Generar; no se confirma la orden.");
  }

  if (await page.locator("button.confirm").first().isVisible({ timeout: TIMEOUTS.confirmation }).catch(() => false)) {
    await captureDebugScreenshot(
      page,
      settings,
      screenshotsDir,
      logger,
      "Confirmacion de orden visible",
      `${capturePrefix}-06-confirmacion`
    );
    await page.click("button.confirm", { timeout: TIMEOUTS.shortAction });
    const confirmedFinished = await waitForPamiLoadingToFinish(page, TIMEOUTS.generar);
    if (!confirmedFinished) {
      throw new Error("PAMI quedo cargando despues de confirmar la orden; no se puede continuar.");
    }
  }

  const completed = await Promise.race([
    page.waitForURL(listUrlRegex, { timeout: TIMEOUTS.generar }).then(() => true).catch(() => false),
    page
      .waitForSelector(settings.selectors.generarBtn, { state: "detached", timeout: TIMEOUTS.generar })
      .then(() => true)
      .catch(() => false)
  ]);

  if (!completed && (await isPamiLoading(page))) {
    throw new Error("PAMI sigue cargando despues de Generar; no se marca la orden como generada.");
  }

  if (!completed) {
    const bodyText = await page.locator("body").innerText({ timeout: TIMEOUTS.bodyText }).catch(() => "");
    const compactText = bodyText.replace(/\s+/g, " ").trim().slice(0, 250);
    if (!/orden|solicitud|generad|confirm/i.test(compactText)) {
      throw new Error(`No se pudo confirmar que PAMI haya generado la orden. Texto visible: ${compactText || "sin texto"}`);
    }
  }

  await abrirFormularioNuevo(page, settings, {
    screenshotsDir,
    logger,
    screenshotName: `${capturePrefix}-error-formulario-siguiente`
  });
  await captureDebugScreenshot(
    page,
    settings,
    screenshotsDir,
    logger,
    "Formulario listo para la siguiente carga",
    `${capturePrefix}-07-formulario-siguiente`
  );
}

async function login(page, settings, logger, screenshotsDir) {
  const maxLoginAttempts = 1;
  for (let attempt = 1; attempt <= maxLoginAttempts; attempt += 1) {
    if (attempt > 1) {
      logger.warn("PAMI devolvio sesion expirada o sin permisos. Limpiando sesion y reintentando login...");
      await page.context().clearCookies().catch(() => null);
    }

    logger.info(`Iniciando sesión en PAMI${attempt > 1 ? ` (intento ${attempt})` : ""}...`);
    await page.goto(settings.loginUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.loginPageLoad });
    await page.waitForSelector(settings.selectors.usuarioInput, { timeout: TIMEOUTS.selector });
    await captureDebugScreenshot(
      page,
      settings,
      screenshotsDir,
      logger,
      "Pantalla de login cargada",
      attempt > 1 ? `00-login-intento-${attempt}` : "00-login"
    );
    await page.fill(settings.selectors.usuarioInput, settings.credentials.usuario);
    await page.fill(settings.selectors.passwordInput, settings.credentials.password);
    await clickLoginButton(page, settings);

    try {
      await abrirFormularioNuevo(page, settings, {
        screenshotsDir,
        logger,
        screenshotName: attempt > 1 ? `01-error-formulario-intento-${attempt}` : "01-error-formulario"
      });
    } catch (error) {
      if (attempt < maxLoginAttempts && error.code === "PAMI_SESSION_BLOCKED") {
        continue;
      }
      throw error;
    }

    await captureDebugScreenshot(page, settings, screenshotsDir, logger, "Formulario de carga abierto", "01-formulario");
    logger.info("Sesión iniciada correctamente.");
    return;
  }
}

async function procesarPaciente(page, patient, patientFolder, settings, screenshotsDir, logger, capturePrefix, signal) {
  throwIfCancelled(signal);
  await asegurarNroBeneficio(page);
  await waitForEditableInput(page, settings.selectors.afiliadoInput, TIMEOUTS.afiliadoInput);
  await captureDebugScreenshot(
    page,
    settings,
    screenshotsDir,
    logger,
    `Formulario listo para afiliado ${patient.afiliado}`,
    `${capturePrefix}-02-formulario-afiliado`
  );
  throwIfCancelled(signal);
  const selectedAfiliado = await buscarYSeleccionarAfiliado(page, settings, patient, logger);
  await captureDebugScreenshot(
    page,
    settings,
    screenshotsDir,
    logger,
    `Afiliado ${selectedAfiliado} seleccionado`,
    `${capturePrefix}-03-afiliado-seleccionado`
  );

  if (patient.telefonoArea && patient.telefono) {
    logger.info(`Telefono detectado: area ${patient.telefonoArea}, numero ${patient.telefono}.`);
  } else {
    logger.warn(`No se detecto telefono completo para ${patient.afiliado}; PAMI puede rechazar la orden.`);
  }

  if (patient.telefonoArea) {
    await typeLikeHuman(page, settings.selectors.telefonoArea, patient.telefonoArea);
    await pressEnter(page, settings.selectors.telefonoArea);
  }

  if (patient.telefono) {
    await typeLikeHuman(page, settings.selectors.telefonoNumero, patient.telefono);
    await pressEnter(page, settings.selectors.telefonoNumero);
  }

  throwIfCancelled(signal);
  await selectByBestText(page, settings.selectors.motivoSelect, settings.fixed.motivo);
  await typeLikeHuman(page, settings.selectors.diagnosticoInput, settings.fixed.diagnostico);
  await acceptAutocompleteOrKeepTypedValue(
    page,
    settings.selectors.diagnosticoInput,
    settings.autocompleteSelectors,
    settings.fixed.diagnostico
  );
  await selectByBestText(page, settings.selectors.modalidadSelect, settings.fixed.modalidad);
  await typeLikeHuman(page, settings.selectors.practicaInput, settings.fixed.practica);
  await selectRequiredAutocomplete(
    page,
    settings.selectors.practicaInput,
    settings.autocompleteSelectors,
    settings.fixed.practica,
    TIMEOUTS.practicaAutocomplete
  );
  await agregarPracticaYEsperarDocumentacion(page, settings);

  throwIfCancelled(signal);
  await cargarDocumentacionPDF(page, patient, patientFolder, settings);

  if (patient.ome) {
    await cargarNumeroOME(page, settings, patient.ome);
  }

  await captureDebugScreenshot(
    page,
    settings,
    screenshotsDir,
    logger,
    `Datos cargados para afiliado ${patient.afiliado}`,
    `${capturePrefix}-04-datos-cargados`
  );
  throwIfCancelled(signal);
  await generarYVolver(page, settings, screenshotsDir, logger, capturePrefix);
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

async function saveRunVideo(page, videosDir, logger) {
  if (!page || !videosDir) {
    return null;
  }

  const video = page.video();
  if (!video) {
    return null;
  }

  fs.mkdirSync(videosDir, { recursive: true });
  const targetPath = path.join(videosDir, `bot-${Date.now()}.webm`);
  try {
    const sourcePath = await video.path();
    fs.copyFileSync(sourcePath, targetPath);
    logger.info(`Video de la ejecucion guardado. Video: ${targetPath}`);
    return targetPath;
  } catch (error) {
    logger.warn(`No se pudo guardar el video de la ejecucion: ${error.message}`);
    return null;
  }
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
        const estimatedOrders = patient.cantidadAudifonos || 1;
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
          inspection.estimatedOrders += estimatedOrders;
        }

        inspection.patients.push({
          folder: folderName,
          docx: docName,
          afiliado: patient.afiliado,
          telefonoArea: patient.telefonoArea,
          telefono: patient.telefono,
          ome: patient.ome,
          estimatedOrders,
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

async function runPamiBot({ rawSettings, inputDir, screenshotsDir, videosDir, log, signal }) {
  const settings = mergeSettings(defaultSettings, rawSettings);
  const logger = createLogger(log);
  const summary = buildSummary();

  if (!settings.credentials.usuario || !settings.credentials.password) {
    throw new Error("Faltan las credenciales de PAMI.");
  }

  let browser;
  let context;
  let page;
  const effectiveVideosDir = settings.recordVideo ? videosDir : null;

  try {
    throwIfCancelled(signal);
    browser = await chromium.launch(getBrowserLaunchOptions(settings, logger));
    context = await browser.newContext({
      timezoneId: settings.timezoneId,
      locale: settings.locale,
      recordVideo: effectiveVideosDir
        ? {
            dir: effectiveVideosDir,
            size: {
              width: 1280,
              height: 720
            }
          }
        : undefined
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUTS.defaultAction);
    page.setDefaultNavigationTimeout(TIMEOUTS.loginNavigation);

    const patientsRoot = resolvePatientsRoot(inputDir);
    logger.info(`Leyendo pacientes desde ${patientsRoot}`);
    throwIfCancelled(signal);
    await login(page, settings, logger, screenshotsDir);

    const patientFolders = listPatientFolders(patientsRoot);
    summary.folders = patientFolders.length;

    if (!patientFolders.length) {
      throw new Error("No se encontraron carpetas ni archivos de pacientes para procesar.");
    }

    for (const patientFolder of patientFolders) {
      throwIfCancelled(signal);
      const docxFiles = listFilesByExt(patientFolder, [".docx"]);
      if (!docxFiles.length) {
        logger.warn(`No hay archivos .docx en ${path.basename(patientFolder)}. Se omite.`);
        summary.skipped += 1;
        continue;
      }

      for (const docxPath of docxFiles) {
        throwIfCancelled(signal);
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

        const cargas = patient.cantidadAudifonos || 1;
        logger.info(`Afiliado ${patient.afiliado}: se realizaran ${cargas} carga(s) por este DOCX.`);

        for (let carga = 1; carga <= cargas; carga += 1) {
          throwIfCancelled(signal);
          try {
            logger.info(`Carga ${carga}/${cargas} para afiliado ${patient.afiliado}.`);
            await abrirFormularioNuevo(page, settings, {
              screenshotsDir,
              logger,
              screenshotName: `${patient.afiliado}-error-formulario-inicial-${carga}`
            });
            throwIfCancelled(signal);
            await procesarPaciente(
              page,
              patient,
              patientFolder,
              settings,
              screenshotsDir,
              logger,
              cargas > 1 ? `${patient.afiliado}-${carga}` : patient.afiliado,
              signal
            );
            summary.generated += 1;
            logger.info(`Orden generada correctamente para ${patient.afiliado} (${carga}/${cargas}).`);
          } catch (error) {
            summary.failed += 1;
            const safeName = sanitizeSlug(cargas > 1 ? `${patient.afiliado}-${carga}` : patient.afiliado) || `error-${Date.now()}`;
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
    if (page) {
      await saveRunVideo(page, effectiveVideosDir, logger);
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
