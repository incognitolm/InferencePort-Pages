import { loadAuth, getTempId } from './auth.js';
import { openModal, closeModal, openImageModal } from './modals.js';
import { escHtml, showNotification } from './ui.js';
import { on } from './ws.js';

const mediaUrlCache = new Map();

const state = {
  view: 'active',
  parentId: null,
  items: [],
  breadcrumbs: [],
  selectedIds: new Set(),
  editor: null,
};

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const auth = loadAuth();
  if (auth?.access_token) headers.Authorization = `Bearer ${auth.access_token}`;
  else headers['X-Temp-ID'] = getTempId();
  return headers;
}

async function apiFetch(url, options = {}, expectJson = true) {
  const headers = authHeaders(options.headers || {});
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const data = expectJson ? await res.json().catch(() => ({})) : null;
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return expectJson ? res.json() : res;
}

function bytesLabel(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function kindIcon(item) {
  if (item.type === 'folder') return '📁';
  if (item.kind === 'image') return '🖼️';
  if (item.kind === 'video') return '🎬';
  if (item.kind === 'audio') return '🎵';
  if (item.kind === 'rich_text') return '📝';
  if (item.kind === 'text') return '📄';
  return '📦';
}

function isTextLike(item) {
  return item.kind === 'text' || item.kind === 'rich_text';
}

function isAttachable(item) {
  return item.kind === 'image' || item.kind === 'text' || item.kind === 'rich_text';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function uploadFileToLibrary(file, { parentId = null, sessionId = null, kind = null } = {}) {
  const body = await file.arrayBuffer();
  const res = await apiFetch('/api/media/upload', {
    method: 'POST',
    headers: {
      'X-File-Name': encodeURIComponent(file.name),
      'X-Mime-Type': file.type || 'application/octet-stream',
      ...(parentId ? { 'X-Parent-Id': parentId } : {}),
      ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
      ...(kind ? { 'X-File-Kind': kind } : {}),
    },
    body,
  });
  await refreshMediaList();
  return res.item;
}

export async function uploadTextToLibrary(name, content, { parentId = null, sessionId = null, richText = false } = {}) {
  const body = new TextEncoder().encode(content);
  const res = await apiFetch('/api/media/upload', {
    method: 'POST',
    headers: {
      'X-File-Name': encodeURIComponent(name),
      'X-Mime-Type': richText ? 'text/html' : 'text/plain',
      ...(parentId ? { 'X-Parent-Id': parentId } : {}),
      ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
      'X-File-Kind': richText ? 'rich_text' : 'text',
    },
    body,
  });
  await refreshMediaList();
  return res.item;
}

export async function fetchMediaBlob(id, { download = false } = {}) {
  const res = await apiFetch(`/api/media/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`, {}, false);
  return res.blob();
}

export async function getMediaObjectUrl(id) {
  if (mediaUrlCache.has(id)) return mediaUrlCache.get(id);
  const blob = await fetchMediaBlob(id);
  const url = URL.createObjectURL(blob);
  mediaUrlCache.set(id, url);
  return url;
}

export async function downloadMediaItem(item) {
  const blob = await fetchMediaBlob(item.id, { download: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.name || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function loadMediaText(id) {
  const res = await apiFetch(`/api/media/${encodeURIComponent(id)}/text`);
  return res;
}

export async function saveMediaText(id, payload) {
  const res = await apiFetch(`/api/media/${encodeURIComponent(id)}/text`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await refreshMediaList();
  return res.item;
}

async function createFolder(name, parentId) {
  const res = await apiFetch('/api/media/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parentId }),
  });
  await refreshMediaList();
  return res.item;
}

async function createDocument({ name, richText, parentId }) {
  const res = await apiFetch('/api/media/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, richText, parentId }),
  });
  await refreshMediaList();
  return res.item;
}

async function trashItems(ids) {
  await apiFetch('/api/media/trash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selectedIds.clear();
  await refreshMediaList();
}

async function restoreItems(ids) {
  await apiFetch('/api/media/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selectedIds.clear();
  await refreshMediaList();
}

async function deleteItemsForever(ids) {
  await apiFetch('/api/media/deleteForever', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  state.selectedIds.clear();
  await refreshMediaList();
}

async function moveItems(ids, parentId = null) {
  await apiFetch('/api/media/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, parentId }),
  });
  state.selectedIds.clear();
  await refreshMediaList();
}

async function loadList() {
  const res = await apiFetch(`/api/media?view=${encodeURIComponent(state.view)}${state.parentId ? `&parentId=${encodeURIComponent(state.parentId)}` : ''}`);
  state.items = res.items || [];
  state.breadcrumbs = res.breadcrumbs || [];
  renderMediaList();
}

function isMediaPaneVisible() {
  return !document.getElementById('sidebar-media-pane')?.classList.contains('hidden');
}

export async function refreshMediaList() {
  if (!document.getElementById('media-list')) return;
  await loadList().catch((err) => {
    showNotification({ type: 'error', message: err.message || 'Failed to load media', duration: 3000 });
  });
}

function setEditorStatus(message = '', type = 'info') {
  const el = document.getElementById('media-editor-status');
  if (!el) return;
  if (!message) {
    el.classList.add('hidden');
    el.textContent = '';
    el.dataset.kind = '';
    return;
  }
  el.classList.remove('hidden');
  el.textContent = message;
  el.dataset.kind = type;
}

function closeEditor() {
  state.editor = null;
  document.getElementById('media-editor-panel')?.classList.add('hidden');
  document.getElementById('media-editor-content')?.replaceChildren();
  document.getElementById('media-editor-toolbar')?.classList.add('hidden');
  setEditorStatus('');
}

function renderRichTextToolbar(toolbar, contentEl) {
  const actions = [
    ['Bold', 'bold'],
    ['Italic', 'italic'],
    ['Underline', 'underline'],
    ['Bullets', 'insertUnorderedList'],
    ['Quote', 'formatBlock'],
    ['Link', 'createLink'],
  ];
  toolbar.innerHTML = '';
  actions.forEach(([label, command]) => {
    const btn = document.createElement('button');
    btn.className = 'media-editor-tool';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      contentEl.focus();
      if (command === 'createLink') {
        const url = prompt('Link URL');
        if (url) document.execCommand(command, false, url);
      } else if (command === 'formatBlock') {
        document.execCommand(command, false, 'blockquote');
      } else {
        document.execCommand(command, false, null);
      }
    });
    toolbar.appendChild(btn);
  });
}

async function openEditor(item) {
  const panel = document.getElementById('media-editor-panel');
  const titleEl = document.getElementById('media-editor-title');
  const metaEl = document.getElementById('media-editor-meta');
  const contentWrap = document.getElementById('media-editor-content');
  const toolbar = document.getElementById('media-editor-toolbar');
  if (!panel || !contentWrap || !toolbar) return;

  const { content } = await loadMediaText(item.id);
  state.editor = {
    item,
    mode: item.kind === 'rich_text' ? 'rich' : 'text',
  };

  titleEl.textContent = item.name;
  metaEl.textContent = `${item.kind === 'rich_text' ? 'Rich text' : 'Text'} • ${bytesLabel(item.size || content.length)}`;
  contentWrap.innerHTML = '';

  if (state.editor.mode === 'rich') {
    const editor = document.createElement('div');
    editor.className = 'media-rich-editor';
    editor.contentEditable = 'true';
    editor.innerHTML = content || '<p></p>';
    contentWrap.appendChild(editor);
    toolbar.classList.remove('hidden');
    renderRichTextToolbar(toolbar, editor);
    state.editor.getValue = () => editor.innerHTML;
  } else {
    const textarea = document.createElement('textarea');
    textarea.className = 'media-text-editor';
    textarea.value = content || '';
    contentWrap.appendChild(textarea);
    toolbar.classList.add('hidden');
    toolbar.innerHTML = '';
    state.editor.getValue = () => textarea.value;
  }

  panel.classList.remove('hidden');
  setEditorStatus('');
}

async function handleMediaItemClick(item) {
  if (item.type === 'folder') {
    state.parentId = item.id;
    await refreshMediaList();
    return;
  }
  if (isTextLike(item)) {
    await openEditor(item);
    return;
  }
  if (item.kind === 'image') {
    const url = await getMediaObjectUrl(item.id);
    openImageModal(url);
    return;
  }
  await downloadMediaItem(item);
}

function renderSelectionBar() {
  const bar = document.getElementById('media-selection-bar');
  if (!bar) return;
  const selected = state.items.filter((item) => state.selectedIds.has(item.id));
  if (!selected.length) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }

  const downloadable = selected.filter((item) => item.type === 'file');
  if (state.view === 'trash') {
    bar.innerHTML = `
      <span>${selected.length} selected</span>
      <button class="sidebar-action-btn" id="media-bulk-restore">Restore</button>
      <button class="sidebar-action-btn danger" id="media-bulk-delete">Delete Forever</button>
    `;
    bar.classList.remove('hidden');
    bar.querySelector('#media-bulk-restore')?.addEventListener('click', () => restoreItems(selected.map((item) => item.id)));
    bar.querySelector('#media-bulk-delete')?.addEventListener('click', () => {
      if (!confirm('Delete these items permanently? This cannot be undone.')) return;
      deleteItemsForever(selected.map((item) => item.id));
    });
    return;
  }

  bar.innerHTML = `
    <span>${selected.length} selected</span>
    ${downloadable.length ? '<button class="sidebar-action-btn" id="media-bulk-download">Download</button>' : ''}
    <button class="sidebar-action-btn" id="media-bulk-move">Move</button>
    <button class="sidebar-action-btn danger" id="media-bulk-trash">Move to Trash</button>
  `;
  bar.classList.remove('hidden');
  bar.querySelector('#media-bulk-download')?.addEventListener('click', async () => {
    for (const item of downloadable) await downloadMediaItem(item);
  });
  bar.querySelector('#media-bulk-move')?.addEventListener('click', () => {
    openFolderPicker({
      title: 'Move Selected Items',
      confirmLabel: 'Move Here',
      startParentId: state.parentId,
      onSelect: (parentId) => moveItems(selected.map((item) => item.id), parentId),
    });
  });
  bar.querySelector('#media-bulk-trash')?.addEventListener('click', () => trashItems(selected.map((item) => item.id)));
}

function renderBreadcrumbs() {
  const el = document.getElementById('media-breadcrumbs');
  if (!el) return;
  const crumbs = [{ id: null, name: state.view === 'trash' ? 'Trash' : 'Library' }, ...state.breadcrumbs];
  el.innerHTML = crumbs.map((crumb, index) => `
    <button class="media-breadcrumb${index === crumbs.length - 1 ? ' active' : ''}" data-id="${crumb.id || ''}">
      ${escHtml(crumb.name)}
    </button>
  `).join('<span class="media-breadcrumb-sep">/</span>');
  el.querySelectorAll('.media-breadcrumb').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.parentId = btn.dataset.id || null;
      await refreshMediaList();
    });
  });
}

function renderMediaList() {
  renderBreadcrumbs();
  renderSelectionBar();
  const list = document.getElementById('media-list');
  if (!list) return;
  if (!state.items.length) {
    list.innerHTML = `<div class="sidebar-empty-state">${state.view === 'trash' ? 'Trash is empty' : 'No media yet'}</div>`;
    return;
  }

  list.innerHTML = state.items.map((item) => `
    <div class="media-list-item" data-id="${escHtml(item.id)}">
      <label class="media-item-check">
        <input type="checkbox" ${state.selectedIds.has(item.id) ? 'checked' : ''} data-media-check="${escHtml(item.id)}" />
      </label>
      <button class="media-item-main" data-media-open="${escHtml(item.id)}">
        <span class="media-item-icon">${kindIcon(item)}</span>
        <span class="media-item-copy">
          <span class="media-item-name">${escHtml(item.name)}</span>
          <span class="media-item-meta">${item.type === 'folder' ? 'Folder' : `${escHtml(item.kind || 'file')} • ${bytesLabel(item.size)}`}</span>
        </span>
      </button>
      <div class="media-item-actions">
        ${state.view === 'trash'
          ? `<button class="media-item-action" data-media-restore="${escHtml(item.id)}">Restore</button>
             <button class="media-item-action danger" data-media-delete="${escHtml(item.id)}">Delete</button>`
          : `${item.type === 'file' ? `<button class="media-item-action" data-media-download="${escHtml(item.id)}">Download</button>` : ''}
             <button class="media-item-action danger" data-media-trash="${escHtml(item.id)}">Trash</button>`}
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-media-check]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) state.selectedIds.add(input.dataset.mediaCheck);
      else state.selectedIds.delete(input.dataset.mediaCheck);
      renderSelectionBar();
    });
  });

  list.querySelectorAll('[data-media-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = state.items.find((entry) => entry.id === btn.dataset.mediaOpen);
      if (item) handleMediaItemClick(item).catch((err) => {
        showNotification({ type: 'error', message: err.message || 'Unable to open item', duration: 3000 });
      });
    });
  });

  list.querySelectorAll('[data-media-download]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const item = state.items.find((entry) => entry.id === btn.dataset.mediaDownload);
      if (item) downloadMediaItem(item);
    });
  });

  list.querySelectorAll('[data-media-trash]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      trashItems([btn.dataset.mediaTrash]);
    });
  });

  list.querySelectorAll('[data-media-restore]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      restoreItems([btn.dataset.mediaRestore]);
    });
  });

  list.querySelectorAll('[data-media-delete]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!confirm('Delete this item permanently? This cannot be undone.')) return;
      deleteItemsForever([btn.dataset.mediaDelete]);
    });
  });
}

async function promptForFolder() {
  const name = prompt('Folder name');
  if (!name) return;
  await createFolder(name, state.parentId);
}

async function promptForDocument(richText = false) {
  const fallback = richText ? 'Untitled Document.html' : 'Untitled Document.txt';
  const name = prompt(richText ? 'Rich text file name' : 'Text file name', fallback);
  if (!name) return;
  const item = await createDocument({ name, richText, parentId: state.parentId });
  if (item) openEditor(item);
}

export async function mediaItemToAttachment(item) {
  if (!item || !isAttachable(item)) return null;
  if (item.kind === 'image') {
    const blob = await fetchMediaBlob(item.id);
    const dataUrl = await blobToDataUrl(blob);
    const comma = dataUrl.indexOf(',');
    return {
      type: 'image',
      name: item.name,
      mimeType: item.mimeType || blob.type || 'image/png',
      base64: dataUrl.slice(comma + 1),
      mediaId: item.id,
    };
  }
  const loaded = await loadMediaText(item.id);
  return {
    type: 'text',
    name: item.name,
    content: loaded.content || '',
    mediaId: item.id,
  };
}

export function openMediaPicker({ onSelect, allowedKinds = ['image', 'text', 'rich_text'] }) {
  const pickerState = {
    parentId: null,
    items: [],
    breadcrumbs: [],
    selectedIds: new Set(),
  };

  function renderPicker(box) {
    const body = box.querySelector('#media-picker-body');
    const crumbs = [{ id: null, name: 'Library' }, ...pickerState.breadcrumbs];
    body.innerHTML = `
      <div class="media-picker-breadcrumbs">
        ${crumbs.map((crumb, index) => `<button class="media-breadcrumb${index === crumbs.length - 1 ? ' active' : ''}" data-picker-crumb="${crumb.id || ''}">${escHtml(crumb.name)}</button>`).join('<span class="media-breadcrumb-sep">/</span>')}
      </div>
      <div class="media-picker-list">
        ${pickerState.items.length ? pickerState.items.map((item) => `
          <div class="media-picker-item">
            ${item.type === 'folder'
              ? `<button class="media-picker-open" data-picker-open="${escHtml(item.id)}"><span>${kindIcon(item)}</span><span>${escHtml(item.name)}</span></button>`
              : `<label class="media-picker-select ${allowedKinds.includes(item.kind) ? '' : 'disabled'}">
                  <input type="checkbox" ${pickerState.selectedIds.has(item.id) ? 'checked' : ''} ${allowedKinds.includes(item.kind) ? '' : 'disabled'} data-picker-check="${escHtml(item.id)}" />
                  <span>${kindIcon(item)}</span>
                  <span>${escHtml(item.name)}</span>
                </label>`}
          </div>
        `).join('') : '<div class="sidebar-empty-state">Nothing here</div>'}
      </div>
    `;

    body.querySelectorAll('[data-picker-crumb]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        pickerState.parentId = btn.dataset.pickerCrumb || null;
        await loadPicker(box);
      });
    });
    body.querySelectorAll('[data-picker-open]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        pickerState.parentId = btn.dataset.pickerOpen;
        await loadPicker(box);
      });
    });
    body.querySelectorAll('[data-picker-check]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) pickerState.selectedIds.add(input.dataset.pickerCheck);
        else pickerState.selectedIds.delete(input.dataset.pickerCheck);
      });
    });
  }

  async function loadPicker(box) {
    const res = await apiFetch(`/api/media?view=active${pickerState.parentId ? `&parentId=${encodeURIComponent(pickerState.parentId)}` : ''}`);
    pickerState.items = res.items || [];
    pickerState.breadcrumbs = res.breadcrumbs || [];
    renderPicker(box);
  }

  openModal(`
    <div class="modal-header">
      <span class="modal-title">Add From Media Library</span>
      <button class="modal-close" id="media-picker-close">×</button>
    </div>
    <div class="modal-body" id="media-picker-body"></div>
    <div class="modal-footer">
      <button class="btn-ghost" id="media-picker-cancel">Cancel</button>
      <button class="btn-primary" id="media-picker-attach">Attach Selected</button>
    </div>
  `, {
    onOpen(box) {
      box.querySelector('#media-picker-close')?.addEventListener('click', closeModal);
      box.querySelector('#media-picker-cancel')?.addEventListener('click', closeModal);
      box.querySelector('#media-picker-attach')?.addEventListener('click', async () => {
        const items = pickerState.items.filter((item) => pickerState.selectedIds.has(item.id));
        closeModal();
        await onSelect?.(items);
      });
      loadPicker(box).catch((err) => {
        showNotification({ type: 'error', message: err.message || 'Failed to load media', duration: 3000 });
      });
    },
  });
}

function openFolderPicker({ title = 'Choose Folder', confirmLabel = 'Select Folder', startParentId = null, onSelect } = {}) {
  const pickerState = {
    parentId: startParentId,
    items: [],
    breadcrumbs: [],
  };

  function renderPicker(box) {
    const body = box.querySelector('#folder-picker-body');
    const crumbs = [{ id: null, name: 'Library' }, ...pickerState.breadcrumbs];
    const folders = pickerState.items.filter((item) => item.type === 'folder');
    body.innerHTML = `
      <div class="media-picker-breadcrumbs">
        ${crumbs.map((crumb, index) => `<button class="media-breadcrumb${index === crumbs.length - 1 ? ' active' : ''}" data-folder-crumb="${crumb.id || ''}">${escHtml(crumb.name)}</button>`).join('<span class="media-breadcrumb-sep">/</span>')}
      </div>
      <div style="padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-active);margin-bottom:10px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:4px;">Destination</div>
        <div style="font-size:13px;color:var(--text);">${escHtml(crumbs.map((crumb) => crumb.name).join(' / '))}</div>
      </div>
      <div class="media-picker-list">
        ${folders.length ? folders.map((item) => `
          <div class="media-picker-item">
            <button class="media-picker-open" data-folder-open="${escHtml(item.id)}"><span>${kindIcon(item)}</span><span>${escHtml(item.name)}</span></button>
          </div>
        `).join('') : '<div class="sidebar-empty-state">No subfolders here</div>'}
      </div>
    `;

    body.querySelectorAll('[data-folder-crumb]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        pickerState.parentId = btn.dataset.folderCrumb || null;
        await loadPicker(box);
      });
    });
    body.querySelectorAll('[data-folder-open]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        pickerState.parentId = btn.dataset.folderOpen;
        await loadPicker(box);
      });
    });
  }

  async function loadPicker(box) {
    const res = await apiFetch(`/api/media?view=active${pickerState.parentId ? `&parentId=${encodeURIComponent(pickerState.parentId)}` : ''}`);
    pickerState.items = res.items || [];
    pickerState.breadcrumbs = res.breadcrumbs || [];
    renderPicker(box);
  }

  openModal(`
    <div class="modal-header">
      <span class="modal-title">${escHtml(title)}</span>
      <button class="modal-close" id="folder-picker-close">×</button>
    </div>
    <div class="modal-body" id="folder-picker-body"></div>
    <div class="modal-footer">
      <button class="btn-ghost" id="folder-picker-cancel">Cancel</button>
      <button class="btn-primary" id="folder-picker-confirm">${escHtml(confirmLabel)}</button>
    </div>
  `, {
    onOpen(box) {
      box.querySelector('#folder-picker-close')?.addEventListener('click', closeModal);
      box.querySelector('#folder-picker-cancel')?.addEventListener('click', closeModal);
      box.querySelector('#folder-picker-confirm')?.addEventListener('click', async () => {
        closeModal();
        await onSelect?.(pickerState.parentId || null);
      });
      loadPicker(box).catch((err) => {
        showNotification({ type: 'error', message: err.message || 'Failed to load folders', duration: 3000 });
      });
    },
  });
}

export function initMediaSidebar() {
  document.querySelectorAll('[data-media-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('[data-media-view]').forEach((tab) => tab.classList.remove('active'));
      btn.classList.add('active');
      state.view = btn.dataset.mediaView;
      state.parentId = null;
      state.selectedIds.clear();
      closeEditor();
      await refreshMediaList();
    });
  });

  document.getElementById('media-upload-btn')?.addEventListener('click', () => {
    document.getElementById('media-upload-input')?.click();
  });
  document.getElementById('media-new-folder-btn')?.addEventListener('click', () => {
    promptForFolder().catch((err) => showNotification({ type: 'error', message: err.message || 'Failed to create folder', duration: 3000 }));
  });
  document.getElementById('media-new-text-btn')?.addEventListener('click', () => {
    promptForDocument(false).catch((err) => showNotification({ type: 'error', message: err.message || 'Failed to create document', duration: 3000 }));
  });
  document.getElementById('media-new-richtext-btn')?.addEventListener('click', () => {
    promptForDocument(true).catch((err) => showNotification({ type: 'error', message: err.message || 'Failed to create document', duration: 3000 }));
  });

  document.getElementById('media-upload-input')?.addEventListener('change', async function handleUpload() {
    try {
      for (const file of this.files) {
        await uploadFileToLibrary(file, { parentId: state.parentId });
      }
    } catch (err) {
      showNotification({ type: 'error', message: err.message || 'Upload failed', duration: 3000 });
    } finally {
      this.value = '';
    }
  });

  document.getElementById('media-editor-close')?.addEventListener('click', closeEditor);
  document.getElementById('media-editor-cancel')?.addEventListener('click', closeEditor);
  document.getElementById('media-editor-save')?.addEventListener('click', async () => {
    if (!state.editor) return;
    try {
      const value = state.editor.getValue();
      const item = await saveMediaText(state.editor.item.id, {
        content: value,
        richText: state.editor.mode === 'rich',
        mimeType: state.editor.mode === 'rich' ? 'text/html' : 'text/plain',
        name: state.editor.item.name,
      });
      state.editor.item = item;
      setEditorStatus('Saved', 'success');
      showNotification({ type: 'success', message: `${item.name} saved`, duration: 1800 });
    } catch (err) {
      setEditorStatus(err.message || 'Save failed', 'error');
    }
  });

  on('media:changed', () => {
    if (isMediaPaneVisible()) refreshMediaList();
  });

  refreshMediaList();
}
