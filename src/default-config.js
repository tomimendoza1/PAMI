const isWindows = process.platform === "win32";

function readBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(String(raw).toLowerCase());
}

const defaultSettings = {
  loginUrl: process.env.PAMI_LOGIN_URL || "https://efectores.pami.org.ar/pami_efectores/login.php",
  formUrl:
    process.env.PAMI_FORM_URL || "https://efectores.pami.org.ar/pami_nc/OP/op_cargar_solicitud.php?xgap_historial=reset",
  browserChannel: process.env.PAMI_BROWSER_CHANNEL ?? (isWindows ? "msedge" : ""),
  headless: readBoolEnv("PAMI_HEADLESS", !isWindows),
  docsTypeText:
    "AUDIOMETRIA / LOGOAUDIOMETRIA / TIMPANOMETRIA / IMPEDANCIOMETRIA + DERIVACION DEL ESPECIALISTA EN ORL",
  credentials: {
    usuario: "",
    password: ""
  },
  fixed: {
    motivo: "PROGRAMA DE ATENCION DE PERSONA HIPOACUSICA",
    diagnostico: "H91",
    practica: "438001",
    modalidad: "AMBULATORIO"
  },
  selectors: {
    usuarioInput: "#c_usuario",
    passwordInput: "#password",
    loginBtn: "#ingresar",
    postLoginCheck: "#busqueda_afiliado",
    afiliadoInput: "#busqueda_afiliado",
    telefonoArea: "input[name=\"cod_area_telefono_afil\"]",
    telefonoNumero: "input[name=\"telefono_afil\"]",
    motivoSelect: "select[name=\"cmb_motivos_emision\"]",
    diagnosticoInput: "#diagn_input",
    modalidadSelect: "#modalidad_input",
    practicaInput: "#practica_input",
    documentacionSelect: "#cmb_tipo_documentacion",
    documentacionAgregarBtn: "#boton_documentacion",
    omeInput: "#n_ome",
    generarBtn: "#generar"
  },
  autocompleteSelectors: [
    ".ui-autocomplete li",
    ".ui-menu-item",
    ".ui-menu-item-wrapper",
    "[role='option']"
  ]
};

module.exports = {
  defaultSettings
};
