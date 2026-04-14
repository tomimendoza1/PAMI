# PAMI Bot Web

Aplicacion web local para ejecutar el bot de ordenes de prestaciones de PAMI desde una interfaz simple. La app toma la logica del script original, permite subir la carpeta de pacientes desde el navegador y muestra el avance en tiempo real.

## Que hace

- Inicia sesion en PAMI con las credenciales que cargues en la pantalla.
- Lee los datos variables desde cada `.docx` con `mammoth`.
- Busca el PDF correspondiente dentro de la carpeta del paciente.
- Permite validar la carpeta antes de ejecutar el bot para detectar DOCX incompletos o PDFs faltantes.
- Completa el formulario de PAMI con los valores fijos y variables.
- Genera una o dos cargas segun la cantidad de audifonos detectada.
- Muestra logs en vivo y guarda capturas si algo falla.

## Estructura esperada

La carpeta que subis desde la web deberia verse asi:

```text
pacientes/
  paciente-1/
    Fecha.docx
    150511819309.pdf
  paciente-2/
    Fecha.docx
    150123456789.pdf
```

Tambien funciona si elegis una carpeta contenedora y adentro hay una unica carpeta raiz con esa estructura.

## Como levantarlo

1. Instala dependencias:

```bash
npm install
```

2. Inicia el servidor:

```bash
npm start
```

Si el puerto `3000` ya esta ocupado, en PowerShell podes levantarlo en otro puerto:

```powershell
$env:PORT=3001
npm start
```

3. Abri [http://localhost:3000](http://localhost:3000)

## Notas importantes

- El proyecto usa `playwright-core` con canal `msedge` por defecto para aprovechar Microsoft Edge instalado en Windows sin descargar Chromium aparte.
- Si preferis usar Chrome, podes cambiarlo desde la interfaz.
- Las credenciales no quedan hardcodeadas en el repositorio.
- Los archivos subidos y las capturas de error se guardan en `storage/jobs/<job-id>/`.
- Tenes un chequeo liviano del servidor en `GET /api/health`.
- Tenes una validacion previa en `POST /api/jobs/inspect` y en el boton `Validar carpeta` de la interfaz.

## Archivos principales

- [server.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/server.js)
- [src/bot/pami-bot.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/src/bot/pami-bot.js)
- [public/index.html](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/public/index.html)
- [public/app.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/public/app.js)
