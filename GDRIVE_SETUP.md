# Guía de integración: Google Drive Sync
## Para mi_rutina_diaria.html — sin backend, sin reescribir nada

---

## Por qué esta arquitectura

### ¿Por qué appDataFolder y no una carpeta normal?

| | appDataFolder | Carpeta normal |
|---|---|---|
| Visible en Drive del usuario | ❌ (oculta) | ✅ |
| Requiere permisos extra | ❌ | ✅ (drive o drive.file) |
| Riesgo de borrado accidental | Bajo | Alto |
| Apropiado para datos de app | ✅ | ❌ |
| Scope OAuth necesario | `drive.appdata` | `drive` o `drive.file` |

**Conclusión:** `appDataFolder` es la elección correcta para datos internos de la app.
El usuario no ve ni modifica el archivo directamente.

### ¿Un archivo o uno por fecha?

Se usa **un único archivo JSON maestro** (`diario-sync.json`) que contiene
todas las claves de localStorage como un objeto plano.

**Razones:**
- La app ya usa localStorage con claves discretas (`rutina_v2`, `proyecto_v2`…).
  Un solo archivo espeja exactamente esa estructura.
- Para uso personal, el archivo raramente supera 500 KB (Drive permite hasta 5 TB).
- Minimiza el número de llamadas a la API de Drive (1 lectura + 1 escritura por sync).
- Evita la complejidad de gestionar múltiples archivos y reconciliar índices.
- La estrategia "un archivo por fecha" solo tiene sentido si los datos son
  inmutables por día, lo cual no aplica aquí (hay datos de proyecto, semana, etc.).

### Estrategia de conflictos: last-write-wins por timestamp

Para uso personal monousuario, "last-write-wins" es suficiente y robusto.
La merge compara `_updatedAt` (nube) vs `_gdrive_local_ts` (localStorage).
El dispositivo con la escritura más reciente prevalece.

---

## Estructura de archivos del proyecto

```
tu-proyecto/
├── mi_rutina_diaria.html      ← MODIFICAR (solo añadir 3 líneas al final del <body>)
├── js/
│   ├── gdrive-sync.js         ← NUEVO — módulo principal de sync
│   └── gdrive-patch.js        ← NUEVO — integración mínima con la app existente
├── vercel.json                ← NUEVO — configuración de Vercel
└── GDRIVE_SETUP.md            ← este archivo
```

---

## Paso 1: Crear el proyecto en Google Cloud Console

1. Ve a https://console.cloud.google.com/
2. Crea un nuevo proyecto (ej: `mi-diario-personal`)
3. En el menú lateral: **APIs y servicios → Biblioteca**
4. Busca **"Google Drive API"** y haz clic en **Habilitar**
5. Ve a **APIs y servicios → Credenciales**
6. Clic en **Crear credenciales → ID de cliente OAuth**
7. Tipo de aplicación: **Aplicación web**
8. Nombre: `Diario Personal`
9. En **Orígenes de JavaScript autorizados**, añade:
   ```
   http://localhost:3000
   https://tu-app.vercel.app
   ```
   (sustituye `tu-app` por el nombre real de tu proyecto en Vercel)
10. En **URIs de redireccionamiento autorizados**, añade exactamente las mismas URLs:
    ```
    http://localhost:3000
    https://tu-app.vercel.app
    ```
11. Haz clic en **Crear**
12. Copia el **Client ID** (formato: `XXXXXXXXX.apps.googleusercontent.com`)

---

## Paso 2: Configurar la pantalla de consentimiento OAuth

1. Ve a **APIs y servicios → Pantalla de consentimiento OAuth**
2. Tipo de usuario: **Externo** (puedes poner **Interno** si tienes Google Workspace)
3. Rellena:
   - Nombre de la app: `Mi Diario Personal`
   - Correo electrónico de asistencia: tu email
   - Información de contacto del desarrollador: tu email
4. En **Ámbitos**, añade:
   - `.../auth/drive.appdata`
5. En **Usuarios de prueba**, añade tu email de Google
6. Guarda y continúa

> ⚠️ Mientras la app esté en modo "Testing", solo los usuarios de prueba
> pueden iniciar sesión. Para uso personal esto es suficiente y no requiere
> verificación de Google.

---

## Paso 3: Modificar mi_rutina_diaria.html

Añade estas **3 líneas** justo antes de `</body>`:

```html
  <!-- Google Drive Sync — añadir al final del body -->
  <script>window.GDRIVE_CLIENT_ID = 'TU_CLIENT_ID_AQUI.apps.googleusercontent.com';</script>
  <script src="js/gdrive-sync.js"></script>
  <script src="js/gdrive-patch.js"></script>
</body>
```

Sustituye `TU_CLIENT_ID_AQUI` por el Client ID del paso 1.

**Eso es todo lo que hay que cambiar en el HTML existente.**

---

## Paso 4: Desplegar en Vercel

### Opción A: Desde GitHub (recomendado)

1. Sube los archivos a tu repositorio GitHub:
   ```
   git add js/gdrive-sync.js js/gdrive-patch.js vercel.json mi_rutina_diaria.html
   git commit -m "feat: add Google Drive sync"
   git push
   ```
2. En Vercel, el deploy se disparará automáticamente.
3. Si es primera vez:
   - Ve a https://vercel.com/
   - Clic en **Add New → Project**
   - Importa tu repositorio de GitHub
   - Framework Preset: **Other**
   - No hace falta configurar nada más (el `vercel.json` ya lo hace todo)
   - Clic en **Deploy**

### Opción B: Vercel CLI

```bash
npm install -g vercel
vercel login
vercel --prod
```

### Variable de entorno (alternativa más segura al Client ID en el HTML)

Si no quieres exponer el Client ID en el HTML versionado:

1. En Vercel Dashboard → tu proyecto → **Settings → Environment Variables**
2. Añade: `GDRIVE_CLIENT_ID` = `tu_client_id.apps.googleusercontent.com`
3. En el HTML, en lugar del script inline, añade al `vercel.json`:
   ```json
   "env": { "GDRIVE_CLIENT_ID": "@gdrive_client_id" }
   ```
   > Nota: como es una SPA estática sin SSR, el método más simple es el
   > script inline. El Client ID de OAuth es público por diseño (no es un secret).

---

## Paso 5: Verificar que funciona

1. Abre la app en `https://tu-app.vercel.app`
2. Deberías ver el badge **"☁️ Sin sesión"** en la esquina inferior derecha
3. Haz clic en el badge → aparece el panel de login
4. Clic en **"Conectar con Google"**
5. Autoriza el acceso a Google Drive
6. El badge cambia a **"✓ Sincronizado"**
7. Crea una entrada en el diario y espera 2 segundos
8. Abre la app en otro dispositivo, haz login, y los datos aparecerán

---

## Comportamiento esperado por situación

| Situación | Comportamiento |
|---|---|
| **Primer inicio** | Crea el archivo en Drive. Carga datos de localStorage si existen |
| **Sin sesión** | App funciona normalmente con localStorage. Badge "Sin sesión" |
| **Token caducado (1h)** | Badge "Error sync". Clic → redirige a re-login automáticamente |
| **Sin red** | Guarda en localStorage con flag "pendiente". Al recuperar red, sube |
| **Dos dispositivos simultáneos** | Last-write-wins por timestamp. El más reciente prevalece |
| **Cerrar pestaña con cambios** | Flag pendiente. Al reabrir → sync automático |
| **Error de servidor Drive** | Reintento exponencial (3 intentos: 3s, 6s, 12s) |

---

## Mantenimiento

### Revocar acceso a Drive
En cualquier momento puedes ir a https://myaccount.google.com/permissions
y revocar el acceso de "Mi Diario Personal".

### Ver/borrar el archivo en Drive
El archivo está en la carpeta oculta `appDataFolder`. Para verlo:
1. Ve a https://drive.google.com/drive/appdata
2. Verás `diario-sync.json`

### Exportar todos los datos
Haz clic en el badge → "Descargar de Drive" → abre DevTools → Console:
```javascript
console.log(JSON.stringify(GDriveSync.getStatus()))
// O para ver los datos:
console.log(localStorage.getItem('rutina_v2'))
```

---

## Notas de seguridad

- El Client ID de OAuth es **público por diseño**. No es un secret. Está
  en el código fuente del navegador de todas formas.
- El Access Token (1h de vida) se guarda en localStorage. Es aceptable para
  uso personal. No compartas el ordenador con sesión abierta.
- Scope `drive.appdata` es el mínimo posible: solo accede al archivo de la app,
  no a ningún otro archivo de tu Drive.
- La app nunca envía datos a ningún servidor propio. Solo Drive + Anthropic API.
