// settings.js — Settings modal
import { send, on, off } from './ws.js';
import { openModal, closeModal, openDeviceSessionModal } from './modals.js';
import { isAuthenticated, currentUser, userProfile, userSettings } from './auth.js';
import { deleteAllSessions } from './sessions.js';
import { escHtml, showNotification } from './ui.js';

const THEME_STORAGE_KEY = 'ipai_theme';

let currentTheme = null;

export function applyTheme(theme, animate = true) {
  const t = theme === 'light' ? 'light' : 'dark';
  if (t === currentTheme) return;
  currentTheme = t;
  try { localStorage.setItem('ipai_theme', t); } catch {}
  if (animate) {
    document.documentElement.classList.add('theme-transitioning');
    setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 400);
  }
  document.documentElement.setAttribute('data-theme', t);
  try {
    const bc = new BroadcastChannel('ipai_theme');
    bc.postMessage({ theme: t });
    bc.close();
  } catch {}
}

try {
  const bc = new BroadcastChannel('ipai_theme');
  bc.onmessage = (e) => {
    if (!e.data?.theme) return;
    const t = e.data.theme === 'light' ? 'light' : 'dark';
    if (t !== currentTheme) {
      if (t === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
      currentTheme = t;
    }
  };
} catch {}

export function openSettings(tab = 'chat') {
  // Always fetch fresh settings from server before building the modal
  if (isAuthenticated()) {
    let opened = false;
    const openOnce = (resolvedSettings) => {
      if (opened) return;
      opened = true;
      _openSettingsModal(tab, resolvedSettings);
    };
    send({ type: 'settings:get' });
    // Wait for the settings response, then open modal with fresh data
    const handler = (msg) => {
      off('settings:data', handler);
      const freshSettings = msg.settings || userSettings || _defaultSettings();
      clearTimeout(fallbackTimer);
      openOnce(freshSettings);
    };
    on('settings:data', handler);
    // Fallback: if no response in 1.5s, open with cached settings
    const fallbackTimer = setTimeout(() => {
      off('settings:data', handler);
      openOnce(userSettings || _defaultSettings());
    }, 1500);
  } else {
    // Guest: use localStorage cached settings
    const stored = (() => {
      try { return JSON.parse(localStorage.getItem('ipai_settings') || '{}'); } catch { return {}; }
    })();
    _openSettingsModal(tab, { ..._defaultSettings(), ...stored });
  }
}

function _defaultSettings() {
  const storedTheme = (() => { try { return localStorage.getItem(THEME_STORAGE_KEY); } catch { return null; } })();
  return { theme: storedTheme || 'dark', webSearch: true, imageGen: true, videoGen: true, audioGen: true };
}

function _openSettingsModal(activeTab, settings) {
  openModal(buildSettingsHtml(activeTab, settings), {
    wide: true,
    onOpen(b) {
      const cleanups = [];
      setupSettingsTabs(b);
      setupChatSettings(b);
      const memoryCleanup = setupMemorySettings(b);
      if (typeof memoryCleanup === 'function') cleanups.push(memoryCleanup);
      if (isAuthenticated()) {
        const accountCleanup = setupAccountSettings(b);
        if (typeof accountCleanup === 'function') cleanups.push(accountCleanup);
      }
      return () => cleanups.forEach((cleanup) => cleanup());
    }
  });
}

function buildSettingsHtml(activeTab, settings) {
  const authed = isAuthenticated();
  const currentTheme = (() => { try { return localStorage.getItem(THEME_STORAGE_KEY) || settings.theme || 'dark'; } catch { return settings.theme || 'dark'; } })();

  return `
  <div class="modal-header">
    <span class="modal-title">Settings</span>
    <button class="modal-close" id="settings-close">×</button>
  </div>
  <div class="settings-tabs">
    <button class="settings-tab ${activeTab==='chat'?'active':''}" data-tab="chat">Chat</button>
    <button class="settings-tab ${activeTab==='memories'?'active':''}" data-tab="memories">Memories</button>
    ${authed ? `<button class="settings-tab ${activeTab==='account'?'active':''}" data-tab="account">Account</button>` : ''}
  </div>

  <!-- Chat Settings -->
  <div class="settings-pane ${activeTab==='chat'?'active':''}" data-pane="chat" style="padding:0 24px 20px;">
    <div class="setting-row">
      <div>
        <div class="setting-label">Theme</div>
        <div class="setting-desc">Light or dark interface</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn-ghost${currentTheme==='light'?' active-theme':''}" data-theme-btn="light" style="font-size:13px;padding:5px 12px;">☀ Light</button>
        <button class="btn-ghost${currentTheme!=='light'?' active-theme':''}" data-theme-btn="dark" style="font-size:13px;padding:5px 12px;">🌙 Dark</button>
      </div>
    </div>

    <div style="margin-top:16px;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Available Tools</div>
    ${buildToolToggle('webSearch',  'Web Search',     'Search the web for current information', settings.webSearch !== false)}
    ${buildToolToggle('imageGen',   'Image Generation','Generate images from prompts', settings.imageGen !== false)}
    ${buildToolToggle('videoGen',   'Video Generation','Generate videos from prompts', settings.videoGen !== false)}
    ${buildToolToggle('audioGen',   'Audio / SFX',    'Generate music and sound effects', settings.audioGen !== false)}
  </div>

  ${buildMemoriesPane(activeTab)}

  ${authed ? buildAccountPane(activeTab) : ''}

  <div class="modal-footer" style="border-top:1px solid var(--border);padding-top:12px;">
    <button class="btn-ghost" id="settings-cancel">Cancel</button>
    <button class="btn-primary" id="settings-apply">Apply</button>
  </div>
  `;
}

function buildToolToggle(key, label, desc, enabled) {
  return `
  <div class="setting-row">
    <div>
      <div class="setting-label">${escHtml(label)}</div>
      <div class="setting-desc">${escHtml(desc)}</div>
    </div>
    <label class="toggle-switch" data-toggle="${key}">
      <input type="checkbox" ${enabled ? 'checked' : ''} />
      <div class="toggle-track"></div>
      <div class="toggle-thumb"></div>
    </label>
  </div>`;
}

function buildMemoriesPane(activeTab) {
  return `
  <div class="settings-pane ${activeTab==='memories'?'active':''}" data-pane="memories" style="padding:0 24px 20px;">
    <div class="form-group" style="margin-top:4px;">
      <label class="form-label">Add Memory</label>
      <div style="display:flex;gap:8px;">
        <input class="form-input" id="memory-create-input" placeholder="Short memory or note" style="flex:1;" />
        <button class="btn-ghost" id="memory-create-btn" style="font-size:13px;padding:6px 14px;white-space:nowrap;">Save</button>
      </div>
      <div class="form-hint">Memories are shared across chats and should stay short.</div>
    </div>
    <div id="memories-list" class="memories-list">
      <div style="font-size:13px;color:var(--text-muted);">Loading memories…</div>
    </div>
  </div>`;
}

function buildAccountPane(activeTab) {
  const u = currentUser;
  const p = userProfile;
  const email = u?.email || '';
  const username = p?.username || '';

  return `
  <div class="settings-pane ${activeTab==='account'?'active':''}" data-pane="account" style="padding:0 24px 8px;">
    <!-- Username -->
    <div class="form-group" style="margin-top:4px;">
      <label class="form-label">Username</label>
      <div style="display:flex;gap:8px;">
        <input class="form-input" id="username-input" value="${escHtml(username)}" placeholder="Choose a username" style="flex:1;" />
        <button class="btn-ghost" id="username-save" style="font-size:13px;padding:6px 14px;white-space:nowrap;">Save</button>
      </div>
      <div id="username-msg" class="form-hint" style="display:none;"></div>
    </div>

    <!-- Plan info -->
    <div id="plan-section" style="padding:12px;border-radius:var(--radius-md);background:var(--bg-raised);border:1px solid var(--border);margin-bottom:16px;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Current Plan</div>
      <div id="plan-name-display" style="font-weight:600;font-size:15px;">Loading…</div>
      <button class="btn-ghost" id="billing-portal-btn" style="margin-top:8px;font-size:12px;padding:5px 12px;">Manage Billing ↗</button>
    </div>

    <!-- Data management -->
    <div style="margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Data</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <button class="btn-danger" id="delete-sessions-btn" style="font-size:13px;">Delete All Chats</button>
    </div>

    <!-- Active sessions -->
    <div style="margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);">Devices &amp; Sessions</div>
    <div id="device-sessions-list" style="margin-bottom:10px;">
      <div style="font-size:13px;color:var(--text-muted);">Loading sessions…</div>
    </div>
    <button class="btn-danger" id="revoke-all-btn" style="font-size:13px;margin-bottom:16px;">Log Out All Other Devices</button>

    <!-- Delete account -->
    <div style="border-top:1px solid var(--border);padding-top:14px;">
      <button class="btn-danger" id="delete-account-btn" style="font-size:13px;">Delete Account</button>
    </div>
  </div>`;
}

function setupSettingsTabs(b) {
  b.querySelector('#settings-close')?.addEventListener('click', closeModal);
  b.querySelector('#settings-cancel')?.addEventListener('click', closeModal);

  b.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      b.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      b.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      b.querySelector(`[data-pane="${tab.dataset.tab}"]`)?.classList.add('active');
    });
  });

  b.querySelector('#settings-apply')?.addEventListener('click', () => applySettings(b));
}

function setupChatSettings(b) {
  b.querySelectorAll('[data-theme-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      b.querySelectorAll('[data-theme-btn]').forEach(t => t.classList.remove('active-theme'));
      btn.classList.add('active-theme');
      applyTheme(btn.dataset.themeBtn);
    });
  });
}

function renderMemoriesList(b, items) {
  const list = b.querySelector('#memories-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">No memories saved yet.</div>';
    return;
  }
  list.innerHTML = items.map((memory) => `
    <div class="memory-item" data-memory-id="${escHtml(memory.id)}">
      <textarea class="memory-textarea">${escHtml(memory.content)}</textarea>
      <div class="memory-meta">
        <span>${escHtml(memory.source || 'assistant')}</span>
        <span>${escHtml(new Date(memory.updatedAt).toLocaleString())}</span>
      </div>
      <div class="memory-actions">
        <button class="btn-ghost memory-save-btn" data-memory-save="${escHtml(memory.id)}">Save</button>
        <button class="btn-danger memory-delete-btn" data-memory-delete="${escHtml(memory.id)}">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-memory-save]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.memorySave;
      const value = list.querySelector(`.memory-item[data-memory-id="${id}"] .memory-textarea`)?.value || '';
      send({ type: 'memories:update', id, content: value });
    });
  });

  list.querySelectorAll('[data-memory-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this memory?')) return;
      send({ type: 'memories:delete', id: btn.dataset.memoryDelete });
    });
  });
}

function loadMemoriesInto(b) {
  const handler = (msg) => {
    unsubscribe();
    if (!b.isConnected) return;
    renderMemoriesList(b, msg.items || []);
  };
  const unsubscribe = on('memories:list', handler);
  send({ type: 'memories:list' });
  return unsubscribe;
}

function setupMemorySettings(b) {
  const unsubs = [];
  let pendingListCleanup = null;
  const reload = () => {
    pendingListCleanup?.();
    pendingListCleanup = loadMemoriesInto(b);
  };

  reload();
  b.querySelector('#memory-create-btn')?.addEventListener('click', () => {
    const input = b.querySelector('#memory-create-input');
    const value = input?.value.trim();
    if (!value) return;
    send({ type: 'memories:create', content: value, source: 'manual' });
    if (input) input.value = '';
  });
  ['memories:created', 'memories:updated', 'memories:deleted', 'memories:changed'].forEach((type) => {
    unsubs.push(on(type, () => {
      if (b.isConnected) reload();
    }));
  });
  return () => {
    pendingListCleanup?.();
    unsubs.forEach((unsubscribe) => unsubscribe?.());
  };
}

function setupAccountSettings(b) {
  const unsubs = [];
  // Username
  b.querySelector('#username-save')?.addEventListener('click', async () => {
    const val = b.querySelector('#username-input')?.value;
    const msgEl = b.querySelector('#username-msg');
    send({ type: 'account:setUsername', username: val });
    const handler = (msg) => {
      off('account:usernameResult', handler);
      msgEl.style.display = '';
      if (msg.success) {
        msgEl.textContent = `Username set to @${msg.username}`;
        msgEl.style.color = 'var(--plan-core)';
      } else {
        msgEl.textContent = msg.error || 'Failed';
        msgEl.style.color = '#f87171';
      }
    };
    on('account:usernameResult', handler);
  });

  // Billing portal
  b.querySelector('#billing-portal-btn')?.addEventListener('click', () => {
    window.open('https://sharktide-lightning.hf.space/portal', '_blank');
  });

  // Delete all sessions
  b.querySelector('#delete-sessions-btn')?.addEventListener('click', () => {
    deleteAllSessions();
    closeModal();
  });

  // Revoke all devices
  b.querySelector('#revoke-all-btn')?.addEventListener('click', () => {
    if (confirm('Log out all other devices?')) {
      send({ type: 'account:revokeAllOthers' });
      showNotification({ type: 'success', message: 'Other sessions logged out', duration: 2500 });
    }
  });

  // Delete account
  b.querySelector('#delete-account-btn')?.addEventListener('click', async () => {
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    const auth = JSON.parse(localStorage.getItem('ipai_auth_v1') || '{}');
    if (!auth.access_token) return;
    const res = await fetch('https://dpixehhdbtzsbckfektd.supabase.co/functions/v1/delete_account', {
      method: 'POST', headers: { Authorization: `Bearer ${auth.access_token}` },
    });
    if (res.ok) {
      closeModal();
      import('./auth.js').then(a => a.logout());
    } else {
      const d = await res.json().catch(() => ({}));
      showNotification({ type: 'error', message: d.error || 'Delete failed', duration: 4000 });
    }
  });

  // Load subscription + device sessions
  send({ type: 'account:getSubscription' });
  send({ type: 'account:getSessions' });

  const subHandler = (msg) => {
    off('account:subscription', subHandler);
    const planEl = b.querySelector('#plan-name-display');
    if (planEl && msg.info) {
      const pKey = msg.info.planKey || 'free';
      const pName = msg.info.planName || 'Free Tier';
      planEl.innerHTML = `<span style="color:var(--plan-${pKey})">${escHtml(pName)}</span>`;
    }
  };
  unsubs.push(on('account:subscription', subHandler));

  const sessHandler = (msg) => {
    off('account:deviceSessions', sessHandler);
    const listEl = b.querySelector('#device-sessions-list');
    if (!listEl) return;
    const sessions = msg.sessions || [];
    const currentToken = msg.currentToken;
    if (sessions.length === 0) {
      listEl.innerHTML = '<div style="font-size:13px;color:var(--text-muted);">No sessions found.</div>';
      return;
    }
    listEl.innerHTML = sessions.map(s => `
      <div class="device-session-item" data-token="${escHtml(s.token)}">
        <div class="device-badge">💻</div>
        <div class="device-info">
          <div class="device-name">${escHtml(s.userAgent?.slice(0,50) || 'Unknown device')}</div>
          <div class="device-meta">${escHtml(s.ip || '—')} · Last seen ${escHtml(s.lastSeen ? new Date(s.lastSeen).toLocaleDateString() : '—')}</div>
          ${s.token === currentToken ? '<div class="device-current">Current session</div>' : ''}
        </div>
      </div>`).join('');

    listEl.querySelectorAll('.device-session-item').forEach(el => {
      el.addEventListener('click', () => {
        const token = el.dataset.token;
        const session = sessions.find(s => s.token === token);
        if (session) openDeviceSessionModal(session, token === currentToken);
      });
    });
  };
  unsubs.push(on('account:deviceSessions', sessHandler));
  return () => {
    unsubs.forEach((unsubscribe) => unsubscribe?.());
  };
}

function applySettings(b) {
  const theme = b.querySelector('[data-theme-btn].active-theme')?.dataset.themeBtn
    || (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  const tools = {};
  b.querySelectorAll('[data-toggle]').forEach(label => {
    const key = label.dataset.toggle;
    const checked = label.querySelector('input[type="checkbox"]').checked;
    tools[key] = checked;
  });

  const newSettings = { theme, ...tools };
  applyTheme(theme);

  // Sync tool buttons in chat UI
  document.querySelectorAll('[data-tool]').forEach(btn => {
    const t = btn.dataset.tool;
    if (t in tools) {
      btn.classList.toggle('active', !!tools[t]);
      btn.style.display = '';
    }
  });

  // Cache for guests
  if (!isAuthenticated()) {
    try { localStorage.setItem('ipai_settings', JSON.stringify(newSettings)); } catch {}
  }

  if (isAuthenticated()) {
    send({ type: 'settings:save', settings: newSettings });
  }

  closeModal();
}

(function initThemeEarly() {
  try {
    const stored = localStorage.getItem('ipai_theme');
    if (stored) {
      document.documentElement.setAttribute('data-theme', stored);
      currentTheme = stored;
    }
  } catch {}
})();

// Apply from auth response
on('auth:ok', (msg) => {
  if (msg.settings?.theme) applyTheme(msg.settings.theme, true);
});
on('auth:guestOk', () => {
  const stored = (() => {
    try { return JSON.parse(localStorage.getItem('ipai_settings') || '{}'); } catch { return {}; }
  })();
  applyTheme(stored.theme || localStorage.getItem(THEME_STORAGE_KEY) || 'dark', false);
});
on('settings:updated', (msg) => {
  if (msg.settings?.theme) applyTheme(msg.settings.theme, true);
});
