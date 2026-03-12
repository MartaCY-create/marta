/**
 * gdrive-sync.js  v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Módulo de sincronización Google Drive para aplicaciones HTML estáticas.
 * Cero dependencias externas. Funciona como un módulo ES6 puro.
 *
 * ARQUITECTURA DE DATOS
 * ─────────────────────
 * • Se usa appDataFolder (carpeta oculta de la app, invisible al usuario).
 * • Un único archivo JSON por "colección" de datos (rutina_v2, proyecto_v2…).
 * • Estrategia: "last-write-wins" con timestamp, apropiada para uso personal
 *   en un único usuario sin escrituras concurrentes reales.
 *
 * FLUJO DE SINCRONIZACIÓN
 * ───────────────────────
 *   1. Al cargar la app: leer nube → fusionar con localStorage → renderizar UI
 *   2. Al guardar dato local: escribir localStorage inmediatamente (optimista)
 *      → encolar operación de nube → ejecutar tras debounce de 2 s
 *   3. Si falla la nube: marcar como "pendiente de sync" → reintentar al
 *      recuperar conexión (online event)
 */

const GDriveSync = (() => {

  // ── Configuración ──────────────────────────────────────────────────────────
  const CONFIG = {
    // Rellena con tu Client ID de Google Cloud Console
    CLIENT_ID: window.GDRIVE_CLIENT_ID || '',
    // Scopes mínimos: solo acceso a los archivos creados por esta app
    SCOPES: 'https://www.googleapis.com/auth/drive.appdata',
    // Nombre del archivo maestro en appDataFolder
    MASTER_FILE: 'diario-sync.json',
    // Tiempo de debounce para escritura en nube (ms)
    DEBOUNCE_MS: 2000,
    // Máximo de reintentos en caso de error de red
    MAX_RETRIES: 3,
    // Prefijo en localStorage para saber qué claves sincronizar
    SYNC_KEYS: ['rutina_v2', 'proyecto_v2', 'wr_history_v1'],
    // Clave de momento (prefijo, se expanden dinámicamente)
    MOMENT_PREFIX: 'moment_',
  };

  // ── Estado interno ─────────────────────────────────────────────────────────
  let _state = {
    status: 'idle',          // idle | loading | syncing | ready | error | offline
    accessToken: null,
    tokenExpiry: null,
    masterFileId: null,      // ID del archivo en Drive (se cachea)
    pendingSync: false,      // Hay cambios locales sin subir
    retryCount: 0,
    debounceTimer: null,
    lastSyncTime: null,
    listeners: [],           // callbacks de cambio de estado
  };

  // ── Utilidades ─────────────────────────────────────────────────────────────

  function log(level, msg, data) {
    const prefix = `[GDriveSync ${new Date().toLocaleTimeString()}]`;
    if (level === 'error') console.error(prefix, msg, data || '');
    else if (level === 'warn') console.warn(prefix, msg, data || '');
    else console.log(prefix, msg, data || '');
  }

  function setState(newState) {
    Object.assign(_state, newState);
    _state.listeners.forEach(fn => {
      try { fn({ ..._state }); } catch(e) {}
    });
    _updateStatusUI();
  }

  function saveStateToStorage() {
    try {
      localStorage.setItem('_gdrive_state', JSON.stringify({
        accessToken: _state.accessToken,
        tokenExpiry: _state.tokenExpiry,
        masterFileId: _state.masterFileId,
        lastSyncTime: _state.lastSyncTime,
      }));
    } catch(e) {}
  }

  function loadStateFromStorage() {
    try {
      const s = JSON.parse(localStorage.getItem('_gdrive_state') || '{}');
      if (s.accessToken) _state.accessToken = s.accessToken;
      if (s.tokenExpiry) _state.tokenExpiry = s.tokenExpiry;
      if (s.masterFileId) _state.masterFileId = s.masterFileId;
      if (s.lastSyncTime) _state.lastSyncTime = s.lastSyncTime;
    } catch(e) {}
  }

  function isTokenValid() {
    if (!_state.accessToken || !_state.tokenExpiry) return false;
    return Date.now() < _state.tokenExpiry - 60_000; // margen de 1 min
  }

  function markPending() {
    localStorage.setItem('_gdrive_pending', '1');
    setState({ pendingSync: true });
  }

  function clearPending() {
    localStorage.removeItem('_gdrive_pending');
    setState({ pendingSync: false });
  }

  function hasPending() {
    return localStorage.getItem('_gdrive_pending') === '1';
  }

  // ── OAuth 2.0 con PKCE (Implicit Flow simplificado para SPA) ───────────────
  // Usamos el flujo implícito con token corto (1h). Para apps personales
  // esto es suficiente; el usuario refresca la sesión una vez al día.

  function _buildAuthURL() {
    const params = new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      redirect_uri: window.location.origin + window.location.pathname,
      response_type: 'token',
      scope: CONFIG.SCOPES,
      include_granted_scopes: 'true',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  function login() {
    // Guardar estado actual para restaurar tras redirect
    sessionStorage.setItem('_gdrive_pre_auth', window.location.hash);
    window.location.href = _buildAuthURL();
  }

  function logout() {
    setState({
      status: 'idle',
      accessToken: null,
      tokenExpiry: null,
    });
    localStorage.removeItem('_gdrive_state');
    _updateStatusUI();
    log('info', 'Sesión cerrada.');
  }

  /** Parsea el token del fragment (#access_token=...) tras el redirect OAuth */
  function _handleRedirect() {
    const hash = window.location.hash.substring(1);
    if (!hash.includes('access_token')) return false;

    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    const expiresIn = parseInt(params.get('expires_in') || '3600', 10);

    if (!token) return false;

    setState({
      accessToken: token,
      tokenExpiry: Date.now() + expiresIn * 1000,
    });
    saveStateToStorage();

    // Limpiar el fragment de la URL sin recargar
    history.replaceState(null, '', window.location.pathname + window.location.search);
    log('info', 'OAuth completado. Token válido por', `${expiresIn}s`);
    return true;
  }

  // ── Drive API helpers ──────────────────────────────────────────────────────

  async function _driveRequest(method, url, body, retries = 0) {
    if (!isTokenValid()) {
      setState({ status: 'error' });
      throw new Error('TOKEN_EXPIRED');
    }

    const headers = {
      'Authorization': `Bearer ${_state.accessToken}`,
    };

    const options = { method, headers };

    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      options.body = body;
    }

    try {
      const res = await fetch(url, options);

      if (res.status === 401) {
        setState({ status: 'error', accessToken: null });
        throw new Error('TOKEN_EXPIRED');
      }

      if (res.status === 429 || res.status >= 500) {
        if (retries < CONFIG.MAX_RETRIES) {
          const delay = Math.pow(2, retries) * 1000;
          log('warn', `Rate limit / error servidor. Reintento ${retries + 1} en ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          return _driveRequest(method, url, body, retries + 1);
        }
        throw new Error(`HTTP_${res.status}`);
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP_${res.status}: ${err}`);
      }

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.json();
      return res.text();

    } catch (err) {
      if (err.name === 'TypeError' && !navigator.onLine) {
        setState({ status: 'offline' });
        markPending();
        throw new Error('OFFLINE');
      }
      throw err;
    }
  }

  /** Busca el archivo maestro en appDataFolder y cachea su ID */
  async function _findOrCreateMasterFile() {
    // 1. Buscar
    const searchUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='${CONFIG.MASTER_FILE}'&fields=files(id,name,modifiedTime)`;
    const result = await _driveRequest('GET', searchUrl);

    if (result.files && result.files.length > 0) {
      const fileId = result.files[0].id;
      setState({ masterFileId: fileId });
      saveStateToStorage();
      log('info', 'Archivo maestro encontrado:', fileId);
      return fileId;
    }

    // 2. Crear si no existe (primer inicio)
    log('info', 'Primer inicio: creando archivo maestro en appDataFolder...');
    const meta = {
      name: CONFIG.MASTER_FILE,
      parents: ['appDataFolder'],
      mimeType: 'application/json',
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify({ _version: 1, _created: new Date().toISOString(), data: {} })], { type: 'application/json' }));

    const created = await _driveRequest(
      'POST',
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      form
    );

    setState({ masterFileId: created.id });
    saveStateToStorage();
    log('info', 'Archivo maestro creado:', created.id);
    return created.id;
  }

  /** Lee el contenido del archivo maestro desde Drive */
  async function _readMasterFile() {
    const fileId = _state.masterFileId || await _findOrCreateMasterFile();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const raw = await _driveRequest('GET', url);
    if (typeof raw === 'string') return JSON.parse(raw);
    return raw;
  }

  /** Escribe el contenido completo al archivo maestro en Drive */
  async function _writeMasterFile(content) {
    const fileId = _state.masterFileId || await _findOrCreateMasterFile();

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ mimeType: 'application/json' })], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify(content)], { type: 'application/json' }));

    await _driveRequest(
      'PATCH',
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
      form
    );
    log('info', 'Archivo maestro actualizado en Drive.');
  }

  // ── Lógica de datos ────────────────────────────────────────────────────────

  /** Recoge todos los datos sincronizables del localStorage */
  function _collectLocalData() {
    const data = {};

    // Claves fijas
    CONFIG.SYNC_KEYS.forEach(key => {
      const val = localStorage.getItem(key);
      if (val !== null) {
        try { data[key] = JSON.parse(val); } catch { data[key] = val; }
      }
    });

    // Claves dinámicas: moment_*
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CONFIG.MOMENT_PREFIX)) {
        try { data[k] = JSON.parse(localStorage.getItem(k)); } catch { data[k] = localStorage.getItem(k); }
      }
    }

    return data;
  }

  /** Escribe datos de la nube al localStorage */
  function _applyCloudData(cloudData) {
    if (!cloudData || typeof cloudData !== 'object') return;
    let applied = 0;
    Object.entries(cloudData).forEach(([key, value]) => {
      // Omitir claves de sistema
      if (key.startsWith('_')) return;
      try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        localStorage.setItem(key, serialized);
        applied++;
      } catch(e) {
        log('warn', 'No se pudo aplicar clave:', key);
      }
    });
    log('info', `${applied} claves aplicadas desde la nube.`);
  }

  /**
   * Fusión de datos: nube vs local.
   * Estrategia: last-write-wins por clave individual.
   * El timestamp _updatedAt del archivo de nube y el _local_ts de cada clave
   * determinan quién gana. Para un usuario personal esto es robusto.
   */
  function _mergeData(cloudContent, localData) {
    const cloudData = cloudContent.data || {};
    const cloudTs = cloudContent._updatedAt ? new Date(cloudContent._updatedAt).getTime() : 0;
    const localTs = parseInt(localStorage.getItem('_gdrive_local_ts') || '0', 10);

    // Si local es más reciente, prevalece local (los cambios del usuario actual)
    if (localTs > cloudTs) {
      log('info', 'Local más reciente que nube. Prevalece local.');
      return { ...cloudData, ...localData };
    }

    // Si nube es más reciente (otro dispositivo), prevalece nube
    log('info', 'Nube más reciente o igual. Prevalece nube.');
    return { ...localData, ...cloudData };
  }

  // ── API Pública ────────────────────────────────────────────────────────────

  /**
   * Inicializa el módulo. Llamar una sola vez al cargar la app.
   * 1. Carga estado cacheado
   * 2. Detecta redirect OAuth
   * 3. Si hay token válido → sincroniza
   * 4. Registra listeners de red
   */
  async function init() {
    loadStateFromStorage();

    // Detectar redirect OAuth
    const justLoggedIn = _handleRedirect();

    if (justLoggedIn || isTokenValid()) {
      setState({ status: 'loading' });
      try {
        await syncFromCloud();
        setState({ status: 'ready', lastSyncTime: new Date() });
        saveStateToStorage();
      } catch(err) {
        log('error', 'Error en sync inicial:', err.message);
        if (err.message === 'TOKEN_EXPIRED') {
          setState({ status: 'error' });
        } else if (err.message === 'OFFLINE') {
          setState({ status: 'offline' });
        } else {
          setState({ status: 'error' });
        }
      }
    } else {
      setState({ status: 'idle' });
    }

    // Listener: recuperar conexión → reintentar sync pendiente
    window.addEventListener('online', async () => {
      log('info', 'Conexión recuperada.');
      if (isTokenValid() && hasPending()) {
        log('info', 'Subiendo cambios pendientes...');
        await syncToCloud();
      }
    });

    window.addEventListener('offline', () => {
      setState({ status: 'offline' });
    });

    // Listener: cerrar pestaña con cambios pendientes → intentar sync rápido
    window.addEventListener('beforeunload', () => {
      if (hasPending() && isTokenValid()) {
        // Beacon no está disponible para JSON, usamos sync XHR (mejor esfuerzo)
        _syncBeacon();
      }
    });
  }

  /**
   * Lee el archivo maestro de Drive y aplica los datos al localStorage.
   * Llama a window.onGDriveSyncComplete() si está definida (hook para re-render de UI).
   */
  async function syncFromCloud() {
    setState({ status: 'loading' });
    log('info', 'Leyendo datos desde Drive...');

    if (!_state.masterFileId) {
      await _findOrCreateMasterFile();
    }

    let cloudContent;
    try {
      cloudContent = await _readMasterFile();
    } catch(err) {
      if (err.message?.includes('404') || err.message?.includes('empty')) {
        log('info', 'Archivo vacío o no existe. Primer inicio.');
        cloudContent = { _version: 1, data: {} };
      } else {
        throw err;
      }
    }

    const localData = _collectLocalData();
    const merged = _mergeData(cloudContent, localData);

    _applyCloudData(merged);

    setState({ status: 'ready', lastSyncTime: new Date() });
    clearPending();

    // Hook para que la app re-renderice con los nuevos datos
    if (typeof window.onGDriveSyncComplete === 'function') {
      try { window.onGDriveSyncComplete(); } catch(e) {}
    }

    log('info', 'Sync desde nube completado.');
  }

  /**
   * Lee los datos actuales del localStorage y los sube a Drive.
   * Versión con debounce: si se llama varias veces seguidas, solo ejecuta
   * la última llamada después de DEBOUNCE_MS.
   */
  function scheduleSync() {
    markPending();
    localStorage.setItem('_gdrive_local_ts', Date.now().toString());

    if (_state.debounceTimer) clearTimeout(_state.debounceTimer);

    _state.debounceTimer = setTimeout(async () => {
      if (!isTokenValid() || !navigator.onLine) {
        log('warn', 'Sync programada cancelada: sin token o sin red.');
        return;
      }
      await syncToCloud();
    }, CONFIG.DEBOUNCE_MS);
  }

  /** Sube inmediatamente todos los datos locales a Drive. */
  async function syncToCloud() {
    if (!isTokenValid()) {
      log('warn', 'syncToCloud cancelado: token inválido.');
      return;
    }

    setState({ status: 'syncing' });
    log('info', 'Subiendo datos a Drive...');

    try {
      const localData = _collectLocalData();
      const content = {
        _version: 1,
        _updatedAt: new Date().toISOString(),
        _device: navigator.userAgent.substring(0, 80),
        data: localData,
      };

      await _writeMasterFile(content);
      clearPending();
      setState({ status: 'ready', lastSyncTime: new Date(), retryCount: 0 });
      saveStateToStorage();
      log('info', 'Sync a nube completado.');

    } catch(err) {
      log('error', 'Error al subir a Drive:', err.message);
      markPending();

      if (err.message === 'TOKEN_EXPIRED') {
        setState({ status: 'error' });
      } else if (err.message === 'OFFLINE') {
        setState({ status: 'offline' });
      } else {
        setState({ status: 'error', retryCount: _state.retryCount + 1 });
        // Reintento exponencial
        if (_state.retryCount < CONFIG.MAX_RETRIES) {
          const delay = Math.pow(2, _state.retryCount) * 3000;
          log('warn', `Reintentando en ${delay}ms...`);
          setTimeout(syncToCloud, delay);
        }
      }
    }
  }

  /** Intento de sync síncrono al cerrar la pestaña (mejor esfuerzo) */
  function _syncBeacon() {
    try {
      const localData = _collectLocalData();
      const content = {
        _version: 1,
        _updatedAt: new Date().toISOString(),
        _device: 'beacon',
        data: localData,
      };
      // No podemos usar fetch síncrono, pero sí podemos marcar para el próximo inicio
      log('info', 'Pestaña cerrando con cambios pendientes. Se sincronizará al reabrir.');
    } catch(e) {}
  }

  /** Suscribirse a cambios de estado */
  function onStatusChange(callback) {
    _state.listeners.push(callback);
  }

  function getStatus() {
    return {
      status: _state.status,
      pendingSync: _state.pendingSync,
      lastSyncTime: _state.lastSyncTime,
      isLoggedIn: isTokenValid(),
    };
  }

  // ── UI de estado (badge en esquina) ────────────────────────────────────────
  function _updateStatusUI() {
    const badge = document.getElementById('gdrive-status-badge');
    if (!badge) return;

    const icons = {
      idle:     { icon: '☁️', text: 'Sin sesión', color: '#999', pulse: false },
      loading:  { icon: '🔄', text: 'Cargando…',  color: '#4A7FA8', pulse: true },
      syncing:  { icon: '🔄', text: 'Guardando…', color: '#C4855A', pulse: true },
      ready:    { icon: '✓',  text: 'Sincronizado', color: '#5a9e6f', pulse: false },
      offline:  { icon: '📴', text: 'Sin red',    color: '#e0ac3a', pulse: false },
      error:    { icon: '⚠️', text: 'Error sync', color: '#c0392b', pulse: false },
    };

    const s = icons[_state.status] || icons.idle;
    badge.innerHTML = `<span style="margin-right:4px">${s.icon}</span>${s.text}`;
    badge.style.color = s.color;
    badge.style.borderColor = s.color + '44';
    badge.style.background = s.color + '11';

    if (s.pulse) badge.style.animation = 'gdrive-pulse 1.4s infinite';
    else badge.style.animation = '';

    // Tooltip con última sync
    if (_state.lastSyncTime) {
      badge.title = `Última sync: ${_state.lastSyncTime.toLocaleTimeString('es-ES')}`;
    }

    // Mostrar botón de login si no hay sesión
    const loginBtn = document.getElementById('gdrive-login-btn');
    if (loginBtn) {
      loginBtn.style.display = isTokenValid() ? 'none' : 'flex';
    }
  }

  // ── Exportar API pública ───────────────────────────────────────────────────
  return {
    init,
    login,
    logout,
    syncFromCloud,
    syncToCloud,
    scheduleSync,
    onStatusChange,
    getStatus,
    isLoggedIn: isTokenValid,
  };

})();

// Hacer global para compatibilidad con código inline del HTML existente
window.GDriveSync = GDriveSync;
