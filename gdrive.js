/**
 * gdrive.js — Google Drive Sync Module
 *
 * Sincronización mínimamente invasiva con Google Drive (appDataFolder).
 * No modifica la lógica existente del diario. Solo necesita un <script> en index.html.
 *
 * CONFIGURACIÓN:
 *  1. Google Cloud Console → Habilitar Drive API
 *  2. Credenciales → Crear ID de cliente OAuth 2.0 (tipo: Aplicación web)
 *  3. Añadir tu dominio Vercel en "Orígenes de JavaScript autorizados"
 *  4. Pegar el Client ID en CLIENT_ID abajo
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // CONFIGURACIÓN — Reemplaza con tu Client ID de Google OAuth 2.0
  // ═══════════════════════════════════════════════════════════════
  const CLIENT_ID = '237994176618-1su1jp02c4qhaf91bvq1tol4fhqg2v6i.apps.googleusercontent.com';

  // ═══════════════════════════════════════════════════════════════
  // CONSTANTES (no cambiar)
  // ═══════════════════════════════════════════════════════════════
  const SCOPE     = 'https://www.googleapis.com/auth/drive.appdata';
  const FILE_NAME = 'marta-diary-data.json';
  const DEBOUNCE  = 4000;  // ms tras el último guardado antes de sincronizar

  // Claves propias en localStorage (no colisionan con las del diario)
  const LS = {
    fileId:       'gdrive_fid',
    wasAuthed:    'gdrive_authed',
    lastModified: 'gdrive_lm',   // ISO timestamp del último cambio local
  };

  // ═══════════════════════════════════════════════════════════════
  // ESTADO
  // ═══════════════════════════════════════════════════════════════
  let _token      = null;   // access token (solo en memoria, no persiste)
  let _tokenExp   = 0;      // expiración: Date.now() ms
  let _fileId     = localStorage.getItem(LS.fileId) || null;
  let _tokenClient= null;
  let _syncTimer  = null;
  let _pendingSync= false;  // sincronización pendiente (offline o sin token)
  let _status     = 'init'; // init | loggedout | loading | idle | syncing | error | offline

  // ═══════════════════════════════════════════════════════════════
  // HELPERS DE DATOS
  // ═══════════════════════════════════════════════════════════════

  function tryParse(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  }

  function getLastModified() {
    return localStorage.getItem(LS.lastModified) || '2000-01-01T00:00:00.000Z';
  }

  function touchLastModified() {
    localStorage.setItem(LS.lastModified, new Date().toISOString());
  }

  /** Recoge todas las claves moment_* del localStorage en un objeto plano. */
  function _collectMoments() {
    const moments = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('moment_')) continue;
      try { moments[k] = JSON.parse(localStorage.getItem(k)); }
      catch { moments[k] = localStorage.getItem(k); }
    }
    return moments;
  }

  function getAllLocal() {
    return {
      version:       3,
      lastModified:  getLastModified(),
      rutina_v2:     tryParse('rutina_v2',     []),
      proyecto_v2:   tryParse('proyecto_v2',   {}),   // v2: nuevo módulo de proyectos
      wr_history_v1: tryParse('wr_history_v1', []),
      moments:       _collectMoments(),               // notas de mañana/mediodía/noche/espiral
    };
  }

  function setAllLocal(data) {
    if (Array.isArray(data.rutina_v2)) {
      localStorage.setItem('rutina_v2', JSON.stringify(data.rutina_v2));
    }

    // proyecto_v2 (nuevo). Si el archivo de Drive era antiguo y tenía proyecto_v1,
    // lo migramos automáticamente a proyecto_v2.
    if (data.proyecto_v2 && typeof data.proyecto_v2 === 'object') {
      localStorage.setItem('proyecto_v2', JSON.stringify(data.proyecto_v2));
    } else if (data.proyecto_v1 && typeof data.proyecto_v1 === 'object') {
      localStorage.setItem('proyecto_v2', JSON.stringify(data.proyecto_v1));
    }

    if (Array.isArray(data.wr_history_v1)) {
      localStorage.setItem('wr_history_v1', JSON.stringify(data.wr_history_v1));
    }

    // Restaurar todas las notas de momento (moment_*)
    if (data.moments && typeof data.moments === 'object') {
      for (const [k, v] of Object.entries(data.moments)) {
        if (!k.startsWith('moment_') || v == null) continue;
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }

    // Actualizar timestamp local con el del dato ganador
    if (data.lastModified) {
      localStorage.setItem(LS.lastModified, data.lastModified);
    }
    _refreshUI();
  }

  function _refreshUI() {
    // Re-renderiza los componentes que leen de localStorage sin tocar el formulario activo
    try { if (typeof initProyecto === 'function') initProyecto(); } catch {}
    try { if (typeof renderWrHistory === 'function') renderWrHistory(); } catch {}
    try {
      const hist = document.getElementById('history');
      if (hist?.classList.contains('active') && typeof renderHistory === 'function') {
        renderHistory('all');
      }
    } catch {}
  }

  /**
   * Estrategia de merge:
   *  - Gana el lado con lastModified más reciente.
   *  - rutina_v2: merge por ID (union, gana el más reciente por dateISO).
   *  - moments:   merge por clave de fecha (union, gana el más completo para igual día).
   *  - proyecto_v2 y wr_history_v1: last-write-wins del lado ganador.
   */
  function resolveConflict(local, drive) {
    const lt = new Date(local.lastModified || 0).getTime();
    const dt = new Date(drive.lastModified || 0).getTime();

    if (lt >= dt) {
      // Local es igual o más reciente → subir a Drive
      return { winner: local, shouldUpload: true };
    }

    // Drive es más reciente — merge granular de entradas y momentos
    const byId = {};
    for (const e of [...(drive.rutina_v2 || []), ...(local.rutina_v2 || [])]) {
      if (!e?.id) continue;
      if (!byId[e.id] || new Date(e.dateISO) > new Date(byId[e.id]?.dateISO)) {
        byId[e.id] = e;
      }
    }

    // Merge de moments: union de fechas; para la misma fecha, gana el más largo (más contenido)
    const mergedMoments = { ...(drive.moments || {}) };
    for (const [k, localVal] of Object.entries(local.moments || {})) {
      if (!mergedMoments[k]) {
        mergedMoments[k] = localVal;
      } else {
        const driveLen = JSON.stringify(mergedMoments[k] ?? '').length;
        const localLen = JSON.stringify(localVal ?? '').length;
        if (localLen > driveLen) mergedMoments[k] = localVal;
      }
    }

    const merged = {
      ...drive,
      rutina_v2: Object.values(byId).sort((a, b) =>
        new Date(a.dateISO || 0) - new Date(b.dateISO || 0)
      ),
      moments: mergedMoments,
    };
    return { winner: merged, shouldUpload: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // DRIVE API
  // ═══════════════════════════════════════════════════════════════

  function _authHeader() {
    return { Authorization: 'Bearer ' + _token };
  }

  /** Busca el archivo en appDataFolder. Devuelve el fileId o null. */
  async function _findFile() {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q:      `name='${FILE_NAME}'`,
      fields: 'files(id)',
    });
    const res = await fetch(
      'https://www.googleapis.com/drive/v3/files?' + params,
      { headers: _authHeader() }
    );
    if (!res.ok) throw new Error('drive-list:' + res.status);
    const { files } = await res.json();
    return files?.[0]?.id || null;
  }

  /** Crea el archivo con contenido inicial en appDataFolder. */
  async function _createFile(data) {
    const boundary = 'gdrive_' + Date.now().toString(36);
    const meta = JSON.stringify({
      name:     FILE_NAME,
      parents:  ['appDataFolder'],
      mimeType: 'application/json',
    });
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      meta,
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      JSON.stringify(data),
      `--${boundary}--`,
    ].join('\r\n');

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method:  'POST',
        headers: { ..._authHeader(), 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      }
    );
    if (!res.ok) throw new Error('drive-create:' + res.status);
    const { id } = await res.json();
    return id;
  }

  /** Lee el contenido del archivo. Devuelve objeto JSON o null. */
  async function _readFile(fid) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fid}?alt=media`,
      { headers: _authHeader() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('drive-read:' + res.status);
    const text = await res.text();
    if (!text?.trim()) return null;
    return JSON.parse(text);
  }

  /** Actualiza el contenido del archivo (solo media, sin cambiar metadata). */
  async function _updateFile(fid, data) {
    const payload = { ...data, lastModified: new Date().toISOString() };
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=media`,
      {
        method:  'PATCH',
        headers: { ..._authHeader(), 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      }
    );
    if (!res.ok) throw new Error('drive-update:' + res.status);
    // Actualizar el lastModified local para que coincida con Drive
    localStorage.setItem(LS.lastModified, payload.lastModified);
  }

  /** Obtiene el fileId cacheado, o busca/crea el archivo en Drive. */
  async function _getOrCreateFileId() {
    if (_fileId) return _fileId;
    let fid = await _findFile();
    if (!fid) {
      fid = await _createFile(getAllLocal());
    }
    _fileId = fid;
    localStorage.setItem(LS.fileId, fid);
    return fid;
  }

  // ═══════════════════════════════════════════════════════════════
  // LÓGICA DE SINCRONIZACIÓN
  // ═══════════════════════════════════════════════════════════════

  /** Carga inicial desde Drive al abrir la app. */
  async function _initialLoad() {
    if (!_isTokenValid()) { _setStatus('loggedout'); return; }
    _setStatus('loading');
    try {
      const fid       = await _getOrCreateFileId();
      const driveData = await _readFile(fid);

      if (!driveData) {
        // Primera vez: subir datos locales a Drive
        const local = getAllLocal();
        await _updateFile(fid, local);
        _setStatus('idle');
        return;
      }

      const { winner, shouldUpload } = resolveConflict(getAllLocal(), driveData);
      setAllLocal(winner);

      if (shouldUpload) {
        await _updateFile(fid, winner);
      }

      _setStatus('idle');
    } catch (e) {
      _handleError(e, _initialLoad);
    }
  }

  /** Programa una sincronización diferida (debounce). */
  function _scheduleSync() {
    if (!_isTokenValid()) {
      _pendingSync = true;
      return;
    }
    clearTimeout(_syncTimer);
    _showPending();
    _syncTimer = setTimeout(_doSync, DEBOUNCE);
  }

  /** Ejecuta la sincronización inmediata hacia Drive. */
  async function _doSync() {
    if (!_isTokenValid()) {
      _pendingSync = true;
      _tokenClient?.requestAccessToken({ prompt: '' }); // intento silencioso
      return;
    }
    _setStatus('syncing');
    try {
      const fid = await _getOrCreateFileId();
      await _updateFile(fid, getAllLocal());
      _pendingSync = false;
      _setStatus('idle');
    } catch (e) {
      _handleError(e, _doSync);
    }
  }

  function _handleError(err, retryFn) {
    const msg = String(err.message || err);
    console.error('[GDrive]', msg);

    if (msg.includes('401') || msg.includes('403')) {
      // Token expirado o revocado → re-login silencioso
      _token = null;
      _pendingSync = true;
      _tokenClient?.requestAccessToken({ prompt: '' });
      _setStatus('loggedout');
    } else if (!navigator.onLine) {
      _pendingSync = true;
      _setStatus('offline');
    } else {
      _setStatus('error');
      // Reintento automático en 30 segundos
      setTimeout(() => { if (_isTokenValid()) retryFn(); }, 30000);
    }
  }

  function _isTokenValid() {
    return !!_token && Date.now() < _tokenExp;
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTENTICACIÓN (Google Identity Services)
  // ═══════════════════════════════════════════════════════════════

  function _initGIS() {
    if (!window.google?.accounts?.oauth2) return;

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope:     SCOPE,
      callback:  _onToken,
    });

    // Intentar login silencioso si el usuario ya autorizó antes
    if (localStorage.getItem(LS.wasAuthed) === '1') {
      _tokenClient.requestAccessToken({ prompt: '' });
    } else {
      _setStatus('loggedout');
    }
  }

  function _onToken(response) {
    if (response.error) {
      // Login silencioso falló (sesión de Google caducada) → mostrar botón
      _setStatus('loggedout');
      return;
    }
    _token    = response.access_token;
    _tokenExp = Date.now() + (response.expires_in - 60) * 1000;
    localStorage.setItem(LS.wasAuthed, '1');

    _initialLoad().then(() => {
      if (_pendingSync) _doSync();
    });
  }

  /** Solicita autorización (con popup de Google). */
  function login() {
    if (!_tokenClient) {
      _toast('Cargando autenticación de Google...');
      return;
    }
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  /** Revoca el token y limpia el estado local del módulo. */
  function logout() {
    clearTimeout(_syncTimer);
    if (_token) {
      try { google.accounts.oauth2.revoke(_token); } catch {}
    }
    _token    = null;
    _tokenExp = 0;
    _fileId   = null;
    localStorage.removeItem(LS.fileId);
    localStorage.removeItem(LS.wasAuthed);
    _setStatus('loggedout');
  }

  // ═══════════════════════════════════════════════════════════════
  // UI — Barra de estado inyectada tras el hero
  // ═══════════════════════════════════════════════════════════════

  function _injectStyles() {
    const css = `
#gdrive-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 22px;
  background: white;
  border-bottom: 1px solid rgba(0,0,0,.06);
  font-family: 'DM Sans', sans-serif;
  font-size: 12px;
  min-height: 38px;
}
#gdrive-icon { font-size: 13px; flex-shrink: 0; line-height: 1; }
#gdrive-text { flex: 1; color: #6B5E52; line-height: 1.4; }
#gdrive-btn {
  padding: 5px 14px;
  border-radius: 20px;
  font-size: 11px;
  font-family: 'DM Sans', sans-serif;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity .2s;
  border: none;
}
#gdrive-btn.primary   { background: #C4855A; color: white; }
#gdrive-btn.secondary { background: transparent; color: #6B5E52; border: 1px solid rgba(0,0,0,.12); }
#gdrive-btn:hover:not(:disabled) { opacity: .8; }
#gdrive-btn:disabled  { opacity: .4; cursor: default; }
    `.trim();
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function _injectBar() {
    const bar = document.createElement('div');
    bar.id = 'gdrive-bar';
    bar.innerHTML = `
      <span id="gdrive-icon">☁️</span>
      <span id="gdrive-text">Conectar Google Drive para sincronizar entre dispositivos</span>
      <button id="gdrive-btn" class="primary">Conectar</button>
    `;
    const hero = document.querySelector('.hero');
    if (hero) hero.insertAdjacentElement('afterend', bar);
    else       document.body.prepend(bar);
  }

  const _STATUS_CFG = {
    init:      { icon: '☁️', text: 'Iniciando…',                                        btn: null },
    loggedout: { icon: '☁️', text: 'Conectar Google Drive para sincronizar entre dispositivos', btn: { label: 'Conectar',     cls: 'primary',   fn: 'login'  } },
    loading:   { icon: '🔄', text: 'Cargando datos de Drive…',                           btn: null },
    syncing:   { icon: '🔄', text: 'Sincronizando…',                                     btn: null },
    idle:      { icon: '✓',  text: 'Sincronizado con Google Drive',                      btn: { label: 'Desconectar',  cls: 'secondary', fn: 'logout' } },
    error:     { icon: '⚠️', text: 'Error al sincronizar — datos guardados localmente',  btn: { label: 'Reintentar',   cls: 'secondary', fn: 'retry'  } },
    offline:   { icon: '📶', text: 'Sin conexión — se sincronizará al reconectar',       btn: null },
  };

  function _setStatus(s) {
    _status = s;
    const cfg  = _STATUS_CFG[s] || _STATUS_CFG.init;
    const icon = document.getElementById('gdrive-icon');
    const text = document.getElementById('gdrive-text');
    const btn  = document.getElementById('gdrive-btn');
    if (!icon || !text || !btn) return;

    icon.textContent = cfg.icon;
    text.textContent = cfg.text;

    if (cfg.btn) {
      btn.style.display = '';
      btn.textContent   = cfg.btn.label;
      btn.className     = cfg.btn.cls;
      btn.disabled      = false;
      btn.onclick = cfg.btn.fn === 'login'  ? () => login()
                  : cfg.btn.fn === 'logout' ? () => logout()
                  :                           () => _doSync();
    } else {
      btn.style.display = 'none';
    }
  }

  function _showPending() {
    const text = document.getElementById('gdrive-text');
    if (text && _status === 'idle') {
      text.textContent = 'Guardando en Drive…';
    }
  }

  function _toast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
    else console.log('[GDrive]', msg);
  }

  // ═══════════════════════════════════════════════════════════════
  // MONKEY-PATCH — Conecta las funciones de guardado existentes
  // ═══════════════════════════════════════════════════════════════

  function _patchSaves() {
    // Funciones que guardan vía localStorage indirectamente
    ['saveEntries', 'saveProjData', 'saveWrHistory', 'saveMomentNotes'].forEach(name => {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      window[name] = function (...args) {
        orig.apply(this, args);
        touchLastModified();
        _scheduleSync();
      };
    });

    // autosaveMoment escribe directamente a localStorage (sin función de guardado)
    const origAuto = window.autosaveMoment;
    if (typeof origAuto === 'function') {
      window.autosaveMoment = function (...args) {
        origAuto.apply(this, args);
        touchLastModified();
        _scheduleSync();
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENTOS DE RED
  // ═══════════════════════════════════════════════════════════════

  function _setupNetworkListeners() {
    window.addEventListener('offline', () => {
      if (_status !== 'loggedout') _setStatus('offline');
    });
    window.addEventListener('online', () => {
      if (_status === 'offline' || _pendingSync) {
        if (_isTokenValid()) _doSync();
        else _tokenClient?.requestAccessToken({ prompt: '' });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // API PÚBLICA
  // ═══════════════════════════════════════════════════════════════

  window.GDrive = { login, logout, scheduleSync: _scheduleSync, doSync: _doSync };

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════

  function _init() {
    // Guardia: si el CLIENT_ID no ha sido configurado, no hacer nada
    if (CLIENT_ID === 'YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com') {
      console.warn('[GDrive] CLIENT_ID sin configurar. Módulo desactivado.');
      return;
    }

    // Si hay datos locales pero nunca se ha marcado el timestamp (instalación nueva),
    // poner un timestamp reciente para que los datos existentes se suban a Drive.
    if (!localStorage.getItem(LS.lastModified)) {
      const hasDiaryData = tryParse('rutina_v2', []).length > 0
                        || Object.keys(tryParse('proyecto_v2', {})).length > 0
                        || Object.keys(tryParse('proyecto_v1', {})).length > 0;
      if (hasDiaryData) {
        // Marca un timestamp reciente para que los datos existentes se suban a Drive
        localStorage.setItem(LS.lastModified, new Date(Date.now() - 1000).toISOString());
      }
    }

    _injectStyles();
    _injectBar();
    _setStatus('init');
    _patchSaves();
    _setupNetworkListeners();

    // Renovación periódica del token (5 min antes de expirar)
    setInterval(() => {
      if (_token && Date.now() > _tokenExp - 5 * 60 * 1000) {
        _tokenClient?.requestAccessToken({ prompt: '' });
      }
    }, 60_000);

    // Cargar Google Identity Services
    if (window.google?.accounts?.oauth2) {
      _initGIS();
    } else {
      const script    = document.createElement('script');
      script.src      = 'https://accounts.google.com/gsi/client';
      script.async    = true;
      script.defer    = true;
      script.onload   = _initGIS;
      script.onerror  = () => {
        console.error('[GDrive] No se pudo cargar Google Identity Services.');
        _setStatus('error');
      };
      document.head.appendChild(script);
    }
  }

  // Esperar al DOM si es necesario
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
