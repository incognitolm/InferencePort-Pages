import { send, on } from './ws.js';
import { showContextMenu } from './ui.js';
import { showShareModal } from './modals.js';

export let sessions = [];
export let currentSessionId = null;

let deletedChats = [];
let chatSidebarView = 'active';
const deletedSelection = new Set();

const sessionListeners = new Set();
export function onSessionChange(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

function notify(event, data) {
  sessionListeners.forEach((fn) => fn(event, data));
}

on('sessions:list', (msg) => {
  sessions = msg.sessions || [];
  renderChatSidebar();
});

on('sessions:created', (msg) => {
  const existing = sessions.findIndex((session) => session.id === msg.session.id);
  if (existing === -1) sessions.unshift(msg.session);
  else sessions[existing] = msg.session;
  renderChatSidebar();
  notify('created', msg.session);
});

on('sessions:deleted', (msg) => {
  sessions = sessions.filter((session) => session.id !== msg.sessionId);
  if (currentSessionId === msg.sessionId) {
    currentSessionId = sessions[0]?.id || null;
    notify('switched', currentSessionId);
  }
  requestDeletedChats();
  renderChatSidebar();
});

on('sessions:deletedAll', () => {
  sessions = [];
  currentSessionId = null;
  requestDeletedChats();
  renderChatSidebar();
  notify('switched', null);
});

on('sessions:renamed', (msg) => {
  const session = sessions.find((entry) => entry.id === msg.sessionId);
  if (session) session.name = msg.name;
  renderChatSidebar();
});

on('sessions:data', (msg) => {
  const existing = sessions.findIndex((session) => session.id === msg.session.id);
  if (existing >= 0) sessions[existing] = msg.session;
  notify('data', msg.session);
});

on('auth:ok', (msg) => {
  sessions = msg.sessions || [];
  requestDeletedChats();
  renderChatSidebar();
  if (sessions.length > 0) switchSession(sessions[0].id);
  else {
    currentSessionId = null;
    notify('switched', null);
  }
});

on('auth:guestOk', (msg) => {
  sessions = msg.sessions || [];
  requestDeletedChats();
  renderChatSidebar();
  if (sessions.length > 0) switchSession(sessions[0].id);
  else {
    currentSessionId = null;
    notify('switched', null);
  }
});

on('chat:done', (msg) => {
  const session = sessions.find((entry) => entry.id === msg.sessionId);
  if (!session) return;
  session.history = msg.history;
  if (msg.name) session.name = msg.name;
  sessions.sort((a, b) => {
    const aTime = a.history?.at(-1)?.timestamp || a.created;
    const bTime = b.history?.at(-1)?.timestamp || b.created;
    return bTime - aTime;
  });
  renderChatSidebar();
});

on('sessions:imported', (msg) => {
  sessions.unshift(msg.session);
  renderChatSidebar();
  switchSession(msg.session.id);
});

on('trash:chats:list', (msg) => {
  deletedChats = msg.items || [];
  deletedSelection.clear();
  renderChatSidebar();
});

on('trash:chats:restored', (msg) => {
  const restored = msg.sessions || [];
  restored.forEach((session) => {
    if (!sessions.some((existing) => existing.id === session.id)) sessions.unshift(session);
  });
  requestDeletedChats();
  renderChatSidebar();
});

on('trash:chats:changed', () => {
  requestDeletedChats();
});

export function showWelcomeScreen() {
  currentSessionId = null;
  renderChatSidebar();
  notify('switched', null);
}

export function createNewSession() {
  send({ type: 'sessions:create' });
}

export function switchSession(id) {
  currentSessionId = id;
  renderChatSidebar();
  send({ type: 'sessions:get', sessionId: id });
  notify('switched', id);
}

export function deleteSession(id) {
  if (!confirm('Move this chat to Recently Deleted?')) return;
  send({ type: 'sessions:delete', sessionId: id });
}

export function deleteAllSessions() {
  if (!confirm('Move all chats to Recently Deleted?')) return;
  send({ type: 'sessions:deleteAll' });
}

export function renameSession(id, name) {
  send({ type: 'sessions:rename', sessionId: id, name });
  const session = sessions.find((entry) => entry.id === id);
  if (session) session.name = name;
  renderChatSidebar();
}

export function requestSessions() {
  send({ type: 'sessions:list' });
}

export function requestDeletedChats() {
  send({ type: 'trash:chats:list' });
}

export function setChatSidebarView(view) {
  chatSidebarView = view === 'deleted' ? 'deleted' : 'active';
  renderChatSidebar();
}

export function getCurrentSession() {
  return sessions.find((session) => session.id === currentSessionId) || null;
}

function renderChatSidebar() {
  const chatPane = document.getElementById('sidebar-chat-pane');
  if (!chatPane) return;
  document.querySelectorAll('[data-chat-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.chatView === chatSidebarView);
  });
  document.getElementById('session-list')?.classList.toggle('hidden', chatSidebarView !== 'active');
  document.getElementById('deleted-chat-list')?.classList.toggle('hidden', chatSidebarView !== 'deleted');

  if (chatSidebarView === 'active') renderActiveSessions();
  else renderDeletedChats();
}

function renderActiveSessions() {
  const list = document.getElementById('session-list');
  if (!list) return;

  if (sessions.length === 0) {
    list.innerHTML = `<div class="sidebar-empty-state">No chats yet</div>`;
    return;
  }

  const groups = groupByDate(sessions);
  list.innerHTML = groups.map(([label, group]) => `
    <div class="session-group">
      <div class="session-date-label">${escHtml(label)}</div>
      ${group.map((session) => `
        <div class="session-item${session.id === currentSessionId ? ' active' : ''}" data-id="${escHtml(session.id)}">
          <span class="session-name" data-id="${escHtml(session.id)}">${escHtml(session.name || 'New Chat')}</span>
          <button class="session-menu-btn" data-id="${escHtml(session.id)}" title="Options">···</button>
        </div>
      `).join('')}
    </div>
  `).join('');

  list.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (event.target.closest('.session-menu-btn')) return;
      switchSession(el.dataset.id);
    });
  });

  list.querySelectorAll('.session-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openSessionMenu(event, btn.dataset.id);
    });
  });

  list.querySelectorAll('.session-name').forEach((el) => {
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      startInlineRename(el);
    });
  });
}

function renderDeletedChats() {
  const list = document.getElementById('deleted-chat-list');
  const bar = document.getElementById('deleted-chat-selection-bar');
  if (!list || !bar) return;

  if (deletedChats.length === 0) {
    list.innerHTML = `<div class="sidebar-empty-state">No recently deleted chats</div>`;
    bar.classList.add('hidden');
    return;
  }

  list.innerHTML = deletedChats.map((chat) => `
    <div class="deleted-chat-item" data-id="${escHtml(chat.id)}">
      <label class="deleted-chat-check">
        <input type="checkbox" ${deletedSelection.has(chat.id) ? 'checked' : ''} data-chat-check="${escHtml(chat.id)}" />
      </label>
      <div class="deleted-chat-copy">
        <div class="deleted-chat-name">${escHtml(chat.name || 'Deleted Chat')}</div>
        <div class="deleted-chat-meta">Deleted ${new Date(chat.deletedAt).toLocaleString()}</div>
      </div>
      <div class="deleted-chat-actions">
        <button class="deleted-chat-action" data-chat-restore="${escHtml(chat.id)}">Restore</button>
        <button class="deleted-chat-action danger" data-chat-delete="${escHtml(chat.id)}">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-chat-check]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) deletedSelection.add(input.dataset.chatCheck);
      else deletedSelection.delete(input.dataset.chatCheck);
      renderDeletedChatSelectionBar();
    });
  });

  list.querySelectorAll('[data-chat-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      send({ type: 'trash:chats:restore', ids: [btn.dataset.chatRestore] });
    });
  });

  list.querySelectorAll('[data-chat-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this chat permanently? This cannot be undone.')) return;
      send({ type: 'trash:chats:deleteForever', ids: [btn.dataset.chatDelete] });
    });
  });

  renderDeletedChatSelectionBar();
}

function renderDeletedChatSelectionBar() {
  const bar = document.getElementById('deleted-chat-selection-bar');
  if (!bar) return;
  if (!deletedSelection.size) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  const ids = [...deletedSelection];
  bar.innerHTML = `
    <span>${ids.length} selected</span>
    <button class="sidebar-action-btn" id="deleted-chat-restore-selected">Restore</button>
    <button class="sidebar-action-btn danger" id="deleted-chat-delete-selected">Delete Forever</button>
  `;
  bar.classList.remove('hidden');
  bar.querySelector('#deleted-chat-restore-selected')?.addEventListener('click', () => {
    send({ type: 'trash:chats:restore', ids });
  });
  bar.querySelector('#deleted-chat-delete-selected')?.addEventListener('click', () => {
    if (!confirm('Delete the selected chats permanently? This cannot be undone.')) return;
    send({ type: 'trash:chats:deleteForever', ids });
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
      label: 'Move to Recently Deleted', icon: '🗑️', danger: true,
      onClick: () => deleteSession(id),
    },
    {
      label: 'Delete All Chats', icon: '⚠️', danger: true,
      onClick: () => deleteAllSessions(),
    },
  ];
  showContextMenu(e.clientX, e.clientY, items);
}

function groupByDate(allSessions) {
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

  for (const session of allSessions) {
    const t = session.created || 0;
    if (t >= today) groups.get('Today').push(session);
    else if (t >= yesterday) groups.get('Yesterday').push(session);
    else if (t >= week) groups.get('This Week').push(session);
    else groups.get('Older').push(session);
  }

  return [...groups.entries()].filter(([, group]) => group.length > 0);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
