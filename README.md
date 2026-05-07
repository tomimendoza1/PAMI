# PAMI Bot Web

Aplicacion web para ejecutar el bot de ordenes de prestaciones de PAMI desde una interfaz simple. El proyecto queda preparado para estos escenarios:

- `Render`: backend completo con Express, uploads, logs en vivo y Playwright.
- `Railway`: alternativa para el mismo backend completo.
- `Vercel`: frontend estatico que consume la API desplegada en Render o Railway.

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

## Uso local

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

3. Abri `http://localhost:3000`

## Railway

En Railway va el backend completo. El repo ya incluye `Dockerfile`, asi que podes desplegarlo directo como servicio.

### Variables recomendadas

- `PORT`
  Railway la define automaticamente.
- `STORAGE_DIR=/data/storage`
  Recomendado si montas un volumen.
- `CORS_ORIGIN=https://tu-frontend.vercel.app`
  Necesario si el frontend en Vercel va a consumir la API en Railway.
- `PAMI_HEADLESS=true`
  Ya viene asi por defecto en Linux.
- `PAMI_BROWSER_CHANNEL=`
  Vacio para usar Chromium incluido en la imagen de Playwright.
- `PAMI_WEB_USERNAME`
- `PAMI_WEB_PASSWORD`
- `PAMI_AUTH_SECRET`
- `PAMI_AUTH_SAME_SITE=None`
  Recomendado si queres mantener compatibilidad con cookie de sesion.

### Volumen

Si queres conservar capturas y archivos de trabajos entre deploys, monta un volumen y usalo en `STORAGE_DIR`, por ejemplo:

- mount path: `/data`
- env: `STORAGE_DIR=/data/storage`

### URL publica

Cuando Railway te asigne una URL publica, guardala porque la vas a usar en Vercel como `PAMI_API_BASE_URL`.

## Render

En Render tambien va el backend completo. El repo incluye `render.yaml` para crear un Web Service con Docker usando el plan gratis.

### Crear el servicio

1. Subi estos cambios a GitHub.
2. En Render, elegi `New` > `Blueprint`.
3. Conecta el repo y selecciona la rama principal.
4. Render va a leer `render.yaml` y crear el servicio `pami-bot-web`.
5. Cuando te pida secretos, completa:
   - `PAMI_WEB_USERNAME`
   - `PAMI_WEB_PASSWORD`
6. Deja que termine el primer deploy.
7. Abri la URL publica de Render y valida `https://tu-servicio.onrender.com/api/health`.

### Variables incluidas

`render.yaml` ya define:

- `NODE_ENV=production`
- `STORAGE_DIR=/tmp/pami-storage`
- `CORS_ORIGIN=*`
- `PAMI_HEADLESS=true`
- `PAMI_BROWSER_CHANNEL=`
- `PAMI_AUTH_SAME_SITE=Lax`
- `PAMI_AUTH_SECRET` generado automaticamente por Render
- `PAMI_LOGIN_URL`
- `PAMI_FORM_URL`

Si usas un frontend separado en Vercel, cambia:

- En Render: `CORS_ORIGIN=https://tu-frontend.vercel.app`
- En Render: `PAMI_AUTH_SAME_SITE=None`
- En Vercel: `PAMI_API_BASE_URL=https://tu-backend.onrender.com`

Si usas solo la URL de Render, no necesitas Vercel.

### Limites del plan gratis

Render Free sirve para probar, pero no es ideal para uso diario:

- El servicio se duerme despues de 15 minutos sin trafico.
- El primer acceso despues de dormir puede tardar alrededor de un minuto.
- El filesystem es efimero: los uploads, capturas y trabajos guardados se pueden perder al reiniciar, redeployar o dormir el servicio.
- No hay disco persistente en el plan gratis.

Para uso mas estable, cambia el servicio a un plan pago y agrega un disk persistente, por ejemplo con `STORAGE_DIR=/data/storage`.

### Migrar desde Railway a Render

1. En Railway, entra al servicio actual y copia estas variables:
   - `PAMI_WEB_USERNAME`
   - `PAMI_WEB_PASSWORD`
   - `PAMI_AUTH_SECRET` si queres mantener sesiones actuales
   - `PAMI_LOGIN_URL` si lo habias personalizado
   - `PAMI_FORM_URL` si lo habias personalizado
   - `CORS_ORIGIN` si usas frontend separado
2. Crea el Blueprint en Render con `render.yaml`.
3. Carga en Render los secretos que correspondan.
4. Espera el deploy y prueba `/api/health`.
5. Si usas Vercel, cambia `PAMI_API_BASE_URL` para que apunte a la URL nueva de Render.
6. Prueba el login, `Validar carpeta` y una carga chica.
7. Cuando confirmes que Render funciona, podes pausar o eliminar el servicio de Railway.

## Vercel

En Vercel va solo el frontend estatico. No despliegues ahi el backend del bot.

### Variable requerida

- `PAMI_API_BASE_URL`
  Debe apuntar a tu backend en Railway, por ejemplo:

```text
https://tu-app-production.up.railway.app
```

### Build

El proyecto ya queda listo con:

- `vercel.json`
- `npm run build:vercel`
- salida estatica en `dist/vercel`

Vercel va a servir la UI y esa UI va a hablar con Railway usando la URL que pongas en `PAMI_API_BASE_URL`.

## Variables opcionales del backend

- `PAMI_LOGIN_URL`
- `PAMI_FORM_URL`
- `PAMI_BROWSER_CHANNEL`
- `PAMI_HEADLESS`
- `STORAGE_DIR`
- `CORS_ORIGIN`
- `PAMI_WEB_USERNAME`
- `PAMI_WEB_PASSWORD`
- `PAMI_AUTH_SECRET`
- `PAMI_AUTH_SAME_SITE`

## Notas importantes

- En Windows local la app usa `msedge` por defecto.
- En Linux y Railway usa Chromium integrado por defecto.
- Si defines `PAMI_WEB_USERNAME` y `PAMI_WEB_PASSWORD`, la web queda protegida con login.
- El login usa token de sesion firmado y tambien puede dejar cookie como respaldo.
- Las credenciales no quedan hardcodeadas en el repositorio.
- Tenes un chequeo liviano del servidor en `GET /api/health`.
- Tenes una validacion previa en `POST /api/jobs/inspect` y en el boton `Validar carpeta` de la interfaz.
- Si despliegas frontend y backend en dominios distintos, usa `CORS_ORIGIN` con el dominio exacto del frontend.

## Archivos principales

- [server.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/server.js)
- [src/bot/pami-bot.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/src/bot/pami-bot.js)
- [src/default-config.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/src/default-config.js)
- [public/index.html](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/public/index.html)
- [public/app.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/public/app.js)
- [scripts/build-vercel.js](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/scripts/build-vercel.js)
- [Dockerfile](/C:/Users/mendo/OneDrive/Documentos/GitHub/PAMI/Dockerfile)
