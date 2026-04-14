const defaultSettings = {
  loginUrl: "https://efectores.pami.org.ar/pami_efectores/login.php",
  formUrl: "https://efectores.pami.org.ar/pami_nc/OP/op_cargar_solicitud.php?xgap_historial=reset",
  browserChannel: "msedge",
  headless: false,
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
