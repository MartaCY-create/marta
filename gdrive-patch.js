/**
 * gdrive-patch.js  v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Parche de mínima intrusión para integrar GDriveSync en la app existente.
 *
 * INSTRUCCIONES DE USO
 * ────────────────────
 * Añade al final del <body> de mi_rutina_diaria.html, DESPUÉS de todos
 * los scripts existentes:
 *
 *   <script src="js/gdrive-sync.js"></script>
 *   <script src="js/gdrive-patch.js"></script>
 *
 * Este archivo NO modifica el HTML ni el CSS existente. Solo:
 *   1. Inyecta el widget de estado en el DOM
 *   2. Envuelve (monkey-patches) las funciones de guardado existentes
 *      para disparar scheduleSync() automáticamente
 *   3. Inicializa GDriveSync al cargar
 *   4. Define onGDriveSyncComplete para re-renderizar la UI
 */

(function() {
  'use strict';

  // ── 1. Inyectar widget de estado en el DOM ─────────────────────────────────
  function injectWidget() {
    // Widget de estado (badge flotante)
    const badge = document.createElement('div');
    badge.id = 'gdrive-status-badge';
    badge.style.cssText = `
      position: fixed;
      bottom: 80px;
      right: 16px;
      z-index: 9999;
      display: flex;
      align-items: center;
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      font-weight: 500;
      padding: 5px 10px;
      border-radius: 20px;
      border: 1px solid rgba(0,0,0,0.1);
      background: white;
      color: #999;
      cursor: default;
      transition: all 0.3s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      letter-spacing: 0.3px;
    `;
    badge.innerHTML = '☁️ Sin sesión';
    badge.title = 'Estado de sincronización con Google Drive';
    badge.addEventListener('click', _handleBadgeClick);
    document.body.appendChild(badge);

    // Botón de login (panel centrado, visible solo cuando no hay sesión)
    const loginPanel = document.createElement('div');
    loginPanel.id = 'gdrive-login-btn';
    loginPanel.style.cssText = `
      position: fixed;
      bottom: 108px;
      right: 16px;
      z-index: 9999;
      display: none;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    `;
    loginPanel.innerHTML = `
      <div style="
        background: white;
        border-radius: 14px;
        padding: 14px 16px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.12);
        border: 1px solid rgba(0,0,0,0.08);
        max-width: 220px;
        text-align: center;
      ">
        <div style="font-size:13px;font-weight:500;color:#2c2820;margin-bottom:8px;font-family:'DM Sans',sans-serif">
          Activa la sincronización
        </div>
        <div style="font-size:11.5px;color:#888;margin-bottom:12px;line-height:1.5;font-family:'DM Sans',sans-serif">
          Conecta Google Drive para sincronizar entre dispositivos
        </div>
        <button onclick="GDriveSync.login()" style="
          width: 100%;
          padding: 9px 12px;
          background: #2c2820;
          color: white;
          border: none;
          border-radius: 8px;
          font-family: 'DM Sans', sans-serif;
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
        ">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 11C14.2091 11 16 9.20914 16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 9.20914 9.79086 11 12 11Z" fill="white"/>
            <path d="M12 13C7.58172 13 4 16.5817 4 21H20C20 16.5817 16.4183 13 12 13Z" fill="white"/>
          </svg>
          Conectar con Google
        </button>
      </div>
    `;
    document.body.appendChild(loginPanel);

    // Estilos de animación pulse
    const style = document.createElement('style');
    style.textContent = `
      @keyframes gdrive-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    `;
    document.head.appendChild(style);
  }

  function _handleBadgeClick() {
    const status = GDriveSync.getStatus();
    if (!status.isLoggedIn) {
      const loginBtn = document.getElementById('gdrive-login-btn');
      if (loginBtn) loginBtn.style.display = loginBtn.style.display === 'flex' ? 'none' : 'flex';
      return;
    }
    if (status.status === 'error') {
      GDriveSync.syncToCloud();
      return;
    }
    if (status.status === 'ready') {
      _showSyncMenu();
    }
  }

  function _showSyncMenu() {
    // Eliminar menú previo si existe
    const prev = document.getElementById('gdrive-sync-menu');
    if (prev) { prev.remove(); return; }

    const status = GDriveSync.getStatus();
    const menu = document.createElement('div');
    menu.id = 'gdrive-sync-menu';
    menu.style.cssText = `
      position: fixed;
      bottom: 108px;
      right: 16px;
      z-index: 9999;
      background: white;
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.12);
      border: 1px solid rgba(0,0,0,0.08);
      min-width: 200px;
      font-family: 'DM Sans', sans-serif;
    `;

    const lastSync = status.lastSyncTime
      ? `Sync: ${status.lastSyncTime.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`
      : 'Sin sync reciente';

    menu.innerHTML = `
      <div style="font-size:11px;color:#999;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid rgba(0,0,0,0.06)">${lastSync}</div>
      <button onclick="GDriveSync.syncFromCloud().then(()=>document.getElementById('gdrive-sync-menu')?.remove())" style="${_menuBtnStyle('#4A7FA8')}">
        ↓ Descargar de Drive
      </button>
      <button onclick="GDriveSync.syncToCloud().then(()=>document.getElementById('gdrive-sync-menu')?.remove())" style="${_menuBtnStyle('#5a9e6f')}">
        ↑ Subir a Drive
      </button>
      <button onclick="GDriveSync.logout();document.getElementById('gdrive-sync-menu')?.remove()" style="${_menuBtnStyle('#c0392b')}">
        ✕ Cerrar sesión Drive
      </button>
    `;

    document.body.appendChild(menu);
    // Cerrar al clicar fuera
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!menu.contains(e.target) && e.target.id !== 'gdrive-status-badge') {
          menu.remove();
          document.removeEventListener('click', _close);
        }
      });
    }, 100);
  }

  function _menuBtnStyle(color) {
    return `display:block;width:100%;padding:8px 10px;margin-bottom:6px;border:none;border-radius:8px;background:${color}18;color:${color};font-family:'DM Sans',sans-serif;font-size:12.5px;font-weight:500;cursor:pointer;text-align:left;`;
  }

  // ── 2. Monkey-patch de las funciones de guardado existentes ────────────────
  // Envolvemos cada función de save* para que dispare scheduleSync() después.
  // Esto NO modifica el comportamiento existente, solo añade el hook de sync.

  function patchSaveFunctions() {
    const fnNames = [
      'saveEntries',
      'saveProjData',
      'saveWrHistory',
      'saveMomentNotes',
    ];

    fnNames.forEach(name => {
      const original = window[name];
      if (typeof original !== 'function') {
        // Intentar de nuevo después de que el HTML cargue su script
        return;
      }
      window[name] = function(...args) {
        const result = original.apply(this, args);
        // Solo disparar sync si hay sesión activa
        if (GDriveSync && GDriveSync.isLoggedIn()) {
          GDriveSync.scheduleSync();
        }
        return result;
      };
    });
  }

  // También parchar saveInsightNotes y saveWeeklyTracking y saveDailyTracking
  // que guardan directamente via saveProjData (ya cubierto arriba)

  // ── 3. Hook onGDriveSyncComplete ───────────────────────────────────────────
  // Se llama después de descargar datos de la nube.
  // Re-renderiza todos los módulos de la app que leen de localStorage.
  window.onGDriveSyncComplete = function() {
    console.log('[GDrivePatch] Sync completado. Re-renderizando UI...');

    // Módulo diario
    if (typeof loadHistory === 'function') {
      try { loadHistory(); } catch(e) {}
    }
    if (typeof renderHistoryStats === 'function') {
      try { renderHistoryStats(); } catch(e) {}
    }

    // Módulo proyecto
    if (typeof initProyecto === 'function') {
      try { initProyecto(); } catch(e) {}
    }

    // Módulo semana
    if (typeof initWeekReview === 'function') {
      try { initWeekReview(); } catch(e) {}
    }

    // Notas de momentos (mañana/mediodía/noche) del día actual
    ['morning', 'midday', 'night', 'spiral'].forEach(sec => {
      if (typeof loadMomentNotes === 'function') {
        try { loadMomentNotes(sec); } catch(e) {}
      }
    });

    // Contexto del diario
    if (typeof loadJournalContext === 'function') {
      try { loadJournalContext(); } catch(e) {}
    }

    showGDriveToast('✓ Datos sincronizados desde Drive');
  };

  // ── 4. Toast de notificación de sync ──────────────────────────────────────
  window.showGDriveToast = function(msg) {
    // Reutilizar el toast existente de la app si existe
    if (typeof showToast === 'function') {
      showToast(msg);
      return;
    }
    // Fallback propio
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:130px;left:50%;transform:translateX(-50%);background:#2c2820;color:white;padding:10px 20px;border-radius:20px;font-family:'DM Sans',sans-serif;font-size:13px;z-index:99999;opacity:0;transition:opacity .3s`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.style.opacity = '1', 10);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
  };

  // ── 5. Inicialización ──────────────────────────────────────────────────────
  function bootstrap() {
    if (!window.GDriveSync) {
      console.error('[GDrivePatch] GDriveSync no está cargado. ¿Incluiste gdrive-sync.js antes de gdrive-patch.js?');
      return;
    }

    if (!window.GDRIVE_CLIENT_ID) {
      console.warn('[GDrivePatch] GDRIVE_CLIENT_ID no está definido. Define window.GDRIVE_CLIENT_ID antes de cargar este script.');
    }

    injectWidget();

    // Parchear funciones de guardado (con pequeño delay para asegurar que
    // el HTML principal ya ha definido sus funciones)
    setTimeout(patchSaveFunctions, 200);

    // Inicializar sync
    GDriveSync.init().then(() => {
      console.log('[GDrivePatch] GDriveSync inicializado. Estado:', GDriveSync.getStatus().status);
    });
  }

  // Arrancar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

})();
