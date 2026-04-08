// sessions.js - Session list management
import { send, on } from './ws.js';
import { showContextMenu } from './ui.js';
import { showShareModal } from './modals.js';

export let sessions = [];
export let currentSessionId = null;

const sessionListeners = new Set();
export function onSessionChange(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

function notify(event, data) {
  sessionListeners.forEach(fn => fn(event, data));
}

// ── Server events ─────────────────────────────────────────────────────────

on('sessions:list', (msg) => {
  sessions = msg.sessions || [];
  renderSessions();
});

on('sessions:created', (msg) => {
  const existing = sessions.findIndex(s => s.id === msg.session.id);
  if (existing === -1) sessions.unshift(msg.session);
  else sessions[existing] = msg.session;
  renderSessions();
  notify('created', msg.session);
});

on('sessions:deleted', (msg) => {
  sessions = sessions.filter(s => s.id !== msg.sessionId);
  if (currentSessionId === msg.sessionId) {
    currentSessionId = sessions[0]?.id || null;
    notify('switched', currentSessionId);
  }
  renderSessions();
});

on('sessions:deletedAll', () => {
  sessions = [];
  currentSessionId = null;
  renderSessions();
  notify('switched', null);
});

on('sessions:renamed', (msg) => {
  const s = sessions.find(s => s.id === msg.sessionId);
  if (s) s.name = msg.name;
  renderSessions();
});

on('sessions:data', (msg) => {
  const existing = sessions.findIndex(s => s.id === msg.session.id);
  if (existing >= 0) sessions[existing] = msg.session;
  notify('data', msg.session);
});

on('auth:ok', (msg) => {
  sessions = msg.sessions || [];
  renderSessions();
  // On login, show the most recent session if one exists,
  // otherwise show the welcome screen (don't auto-create).
  if (sessions.length > 0) {
    switchSession(sessions[0].id);
  } else {
    currentSessionId = null;
    notify('switched', null);
  }
});

on('auth:guestOk', (msg) => {
  sessions = msg.sessions || [];
  renderSessions();
  // Show welcome screen; session is created lazily when user sends first message.
  if (sessions.length > 0) {
    switchSession(sessions[0].id);
  } else {
    currentSessionId = null;
    notify('switched', null);
  }
});

on('chat:done', (msg) => {
  const s = sessions.find(s => s.id === msg.sessionId);
  if (s) {
    s.history = msg.history;
    if (msg.name) s.name = msg.name;
    sessions.sort((a, b) => {
      const aTime = a.history?.at(-1)?.timestamp || a.created;
      const bTime = b.history?.at(-1)?.timestamp || b.created;
      return bTime - aTime;
    });
    renderSessions();
  }
});

on('sessions:imported', (msg) => {
  sessions.unshift(msg.session);
  renderSessions();
  switchSession(msg.session.id);
});

// ── Actions ───────────────────────────────────────────────────────────────

/**
 * createNewSession is now "lazy" for the new-chat button:
 * the button just navigates to the welcome screen.
 * An actual session is only created when the user sends their first message
 * (handled in app.js triggerCenterSend).
 *
 * Call createNewSession() directly when you really need the session to exist
 * immediately (e.g. from triggerCenterSend in app.js).
 */
export function showWelcomeScreen() {
  currentSessionId = null;
  renderSessions();            // deselect active item in sidebar
  notify('switched', null);   // app.js will show the welcome view
}

export function createNewSession() {
  send({ type: 'sessions:create' });
}

export function switchSession(id) {
  currentSessionId = id;
  renderSessions();
  send({ type: 'sessions:get', sessionId: id });
  notify('switched', id);
}

export function deleteSession(id) {
  send({ type: 'sessions:delete', sessionId: id });
}

export function deleteAllSessions() {
  send({ type: 'sessions:deleteAll' });
}

export function renameSession(id, name) {
  send({ type: 'sessions:rename', sessionId: id, name });
  const s = sessions.find(s => s.id === id);
  if (s) s.name = name;
  renderSessions();
}

export function requestSessions() {
  send({ type: 'sessions:list' });
}

export function getCurrentSession() {
  return sessions.find(s => s.id === currentSessionId) || null;
}

// ── Render ────────────────────────────────────────────────────────────────

function renderSessions() {
  const list = document.getElementById('session-list');
  if (!list) return;

  if (sessions.length === 0) {
    list.innerHTML = `<div style="padding:12px 10px;font-size:12px;color:var(--text-muted)">No chats yet</div>`;
    return;
  }

  // Group by date
  const groups = groupByDate(sessions);
  let html = '';
  for (const [label, group] of groups) {
    html += `<div class="session-date-label">${escHtml(label)}</div>`;
    for (const s of group) {
      const active = s.id === currentSessionId ? ' active' : '';
      html += `
        <div class="session-item${active}" data-id="${escHtml(s.id)}">
          <span class="session-name" data-id="${escHtml(s.id)}">${escHtml(s.name || 'New Chat')}</span>
          <button class="session-menu-btn" data-id="${escHtml(s.id)}" title="Options">···</button>
        </div>`;
    }
  }
  list.innerHTML = html;

  // Session click
  list.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-menu-btn')) return;
      switchSession(el.dataset.id);
    });
  });

  // Menu button
  list.querySelectorAll('.session-menu-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionMenu(e, btn.dataset.id);
    });
  });

  // Inline rename on name click (double click)
  list.querySelectorAll('.session-name').forEach(el => {
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(el);
    });
  });
}

function startInlineRename(el) {
  const id = el.dataset.id;
  const original = el.textContent;
  el.setAttribute('contenteditable', 'true');
  el.focus();
  document.execCommand('selectAll', false, null);

  const finish = () => {
    el.removeAttribute('contenteditable');
    const name = el.textContent.trim();
    if (name && name !== original) renameSession(id, name);
    else el.textContent = original;
  };

  el.addEventListener('blur', finish, { once: true });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.textContent = original; el.blur(); }
  });
}

function openSessionMenu(e, id) {
  const items = [
    {
      label: 'Share', icon: '🔗',
      onClick: () => showShareModal(id),
    },
    {
      label: 'Rename', icon: '✏️',
      onClick: () => {
        const nameEl = document.querySelector(`.session-name[data-id="${id}"]`);
        if (nameEl) startInlineRename(nameEl);
      },
    },
    { separator: true },
    {
      label: 'Delete', icon: '🗑️', danger: true,
      onClick: () => deleteSession(id),
    },
    {
      label: 'Delete All Chats', icon: '⚠️', danger: true,
      onClick: () => {
        if (confirm('Delete all chats? This cannot be undone.')) deleteAllSessions();
      },
    },
  ];
  showContextMenu(e.clientX, e.clientY, items);
}

function groupByDate(sessions) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const week = today - 6 * 86400000;

  const groups = new Map([
    ['Today', []],
    ['Yesterday', []],
    ['This Week', []],
    ['Older', []],
  ]);

  for (const s of sessions) {
    const t = s.created || 0;
    if (t >= today) groups.get('Today').push(s);
    else if (t >= yesterday) groups.get('Yesterday').push(s);
    else if (t >= week) groups.get('This Week').push(s);
    else groups.get('Older').push(s);
  }

  return [...groups.entries()].filter(([, g]) => g.length > 0);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}