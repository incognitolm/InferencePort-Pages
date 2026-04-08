// chat.js — Chat rendering, streaming, versioning, editing
import { send, on, off } from './ws.js';
import { currentSessionId } from './sessions.js';
import {
  renderMarkdown, attachCodeCopyListeners, attachSvgPanelListeners,
  escHtml, showNotification, autoResize,
} from './ui.js';
import { renderFilePreviewRow, clearFilePreviewRow } from './app.js';

let activeSessionId = null;
let isStreaming      = false;
let streamingBubble  = null;
let streamingText    = '';
let streamingSessionId = null; // track which session is streaming
let autoScroll       = true;
let pendingAssets    = [];

const BULLET = '\u2022';

export function setActiveSession(id) {
  activeSessionId = id;
  // Update send button state based on whether this session is streaming
  updateSendBtn(isStreaming && streamingSessionId === id);
}
export function getIsStreaming() { return isStreaming && streamingSessionId === activeSessionId; }

// ── WebSocket events ──────────────────────────────────────────────────────

on('sessions:data',         (msg) => { if (msg.session.id === activeSessionId) renderSession(msg.session); });
on('chat:start',            (msg) => { onChatStart(msg); });
on('chat:token',            (msg) => { if (msg.sessionId === activeSessionId) onToken(msg.token); });
on('chat:done',             (msg) => { onChatDone(msg); });
on('chat:aborted',          (msg) => { onChatAborted(msg); });
on('chat:error',            (msg) => { if (msg.sessionId === activeSessionId) onChatError(msg.error); });
on('chat:asset',            (msg) => { if (msg.sessionId === activeSessionId) appendAsset(msg.asset); });
on('chat:toolCall',         (msg) => { if (msg.sessionId === activeSessionId) handleLiveToolCall(msg.call); });
on('chat:messageEdited',    (msg) => { if (msg.sessionId === activeSessionId) renderHistory(msg.history); });
on('chat:versionSelected',  (msg) => { if (msg.sessionId === activeSessionId) renderHistory(msg.history); });

// Reconnect: reload current session instead of resetting to welcome
on('ws:connected', () => {
  if (activeSessionId) {
    send({ type: 'sessions:get', sessionId: activeSessionId });
  }
});

// ── Tree extraction (mirror of server logic) ──────────────────────────────

function extractFlatHistoryFromTree(rootMessage) {
  if (!rootMessage) return [];
  const history = [];
  const ensureValidContent = (msg) => {
    if (msg.content === undefined || msg.content === null) msg.content = '';
    return msg;
  };
  const extractBranch = (message) => {
    history.push(ensureValidContent(message));
    const currentVersionIdx = message.currentVersionIdx ?? 0;
    const versions = message.versions || [];
    if (currentVersionIdx >= versions.length) return;
    const currentVersion = versions[currentVersionIdx];
    if (!currentVersion) return;
    const tail = currentVersion.tail;
    if (!Array.isArray(tail) || tail.length === 0) return;
    for (const tailMessage of tail) extractBranch(tailMessage);
  };
  extractBranch(rootMessage);
  return history;
}

// ── Views ─────────────────────────────────────────────────────────────────

export function renderSession(session) {
  if (!session || !session.history?.length) { showWelcome(); return; }
  showChat();
  const flatHistory = session.history[0]?.versions
    ? extractFlatHistoryFromTree(session.history[0])
    : session.history;
  renderHistory(flatHistory);
}

function showWelcome() {
  document.getElementById('welcome-view')?.classList.remove('hidden');
  document.getElementById('chat-view')?.classList.add('hidden');
  document.getElementById('bottom-input-bar')?.classList.add('hidden');
}

function showChat() {
  document.getElementById('welcome-view')?.classList.add('hidden');
  document.getElementById('chat-view')?.classList.remove('hidden');
  document.getElementById('bottom-input-bar')?.classList.remove('hidden');
}

// ── Full history render ───────────────────────────────────────────────────

export function renderHistory(history) {
  showChat();
  const box = document.getElementById('chat-messages');
  if (!box) return;
  box.innerHTML = '';

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const cleanMsg = { ...msg, content: stripSessionTag(msg.content) };
    if      (cleanMsg.role === 'user')      appendUserMsg(box, cleanMsg, i);
    else if (cleanMsg.role === 'assistant') appendAssistantMsg(box, cleanMsg, i);
    else if (cleanMsg.role === 'image')     appendMediaMsg(box, 'image', cleanMsg.content);
    else if (cleanMsg.role === 'video')     appendMediaMsg(box, 'video', cleanMsg.content);
    else if (cleanMsg.role === 'audio')     appendMediaMsg(box, 'audio', cleanMsg.content);
  }

  if (typeof renderMathInElement !== 'undefined') {
    try {
      renderMathInElement(box, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$',  right: '$',  display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch {}
  }

  if (autoScroll) box.scrollTop = box.scrollHeight;
}

function stripSessionTag(content) {
  if (typeof content !== 'string') return content;
  return content.replace(/<session_name>[\s\S]*?<\/session_name>/gi, '').trim();
}

// ── Message renderers ─────────────────────────────────────────────────────

function appendUserMsg(box, msg, index) {
  const wrap = makeWrap(index);
  const bubble = document.createElement('div');
  bubble.className = 'msg-user';

  const text = msgText(msg.content);
  const imgs = msgImages(msg.content);
  const files = msgFiles(msg.content);

  // Render text (convert bullet chars back for display)
  const displayText = textWithBullets(text);
  bubble.innerHTML = renderMarkdown(displayText);
  attachCodeCopyListeners(bubble);
  attachSvgPanelListeners(bubble);

  // Image attachments
  imgs.forEach(src => {
    const img = document.createElement('img');
    img.src = src; img.alt = 'Attached image';
    img.style.cssText = 'max-width:100%;max-height:260px;border-radius:8px;margin-top:8px;display:block;cursor:pointer;';
    img.addEventListener('click', () => openImageModal(src));
    bubble.appendChild(img);
  });

  // File attachments — shown as chips
  if (files.length > 0) {
    const fileRow = document.createElement('div');
    fileRow.className = 'msg-file-attachments';
    files.forEach(f => {
      const chip = buildFileChipView(f.name, f.content, false);
      fileRow.appendChild(chip);
    });
    bubble.appendChild(fileRow);
  }

  wrap.appendChild(bubble);

  // Version navigator below the bubble (only on user messages)
  if (msg.versions?.length > 1) {
    wrap.appendChild(buildVersionNav(msg, index));
  }

  // Action buttons
  wrap.appendChild(buildActions([
    { icon: copyIcon(), title: 'Copy', fn: () => copyText(text) },
    { icon: editIcon(), title: 'Edit', fn: () => startUserEdit(wrap, index, msg, text, files) },
  ], 'right'));

  box.appendChild(wrap);
}

function appendAssistantMsg(box, msg, index) {
  const wrap = makeWrap(index);
  const bubble = document.createElement('div');
  bubble.className = 'msg-assistant';
  bubble.innerHTML = renderMarkdown(msg.content || '');
  attachCodeCopyListeners(bubble);
  attachSvgPanelListeners(bubble);

  if (msg.toolCalls?.length) {
    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';
    msg.toolCalls.forEach(c => chipRow.appendChild(buildToolChip(c)));
    bubble.appendChild(chipRow);
  }

  wrap.appendChild(bubble);

  wrap.appendChild(buildActions([
    { icon: copyIcon(), title: 'Copy', fn: () => copyText(msg.content || '') },
    { icon: editIcon(), title: 'Edit', fn: () => startAssistantEdit(wrap, index, msg) },
  ], 'left'));

  box.appendChild(wrap);
}

function appendMediaMsg(box, type, content) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-media';

  if (type === 'image') {
    const img = document.createElement('img');
    img.src = content; img.alt = 'Generated image';
    img.addEventListener('click', () => openImageModal(content));
    wrap.appendChild(img);
    wrap.appendChild(dlBtn(() => dlMedia(content, 'image.png')));
  } else if (type === 'video') {
    const v = document.createElement('video');
    v.src = content; v.controls = true; v.preload = 'metadata';
    wrap.appendChild(v);
    wrap.appendChild(dlBtn(() => dlMedia(content, 'video.mp4')));
  } else if (type === 'audio') {
    const a = document.createElement('audio');
    a.src = content; a.controls = true; a.preload = 'metadata'; a.style.width = '100%';
    wrap.appendChild(a);
    const db = dlBtn(() => dlMedia(content, 'audio.mp3'));
    db.style.cssText += ';position:static;margin-top:6px;opacity:1;';
    wrap.appendChild(db);
  }
  box.appendChild(wrap);
}

// ── File content extraction from message ─────────────────────────────────

/**
 * Extract text file attachments embedded in the message content string.
 * They're stored as <details><summary>name</summary>\n```\ncontent\n```\n</details>
 */
function msgFiles(content) {
  if (typeof content !== 'string') return [];
  const files = [];
  const re = /<details><summary>([^<]+?)<\/summary>\s*```(?:\w*)\n([\s\S]*?)\n```\s*<\/details>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    files.push({ name: m[1].trim(), content: m[2] });
  }
  return files;
}

/**
 * Strip the embedded file details blocks from display text so we show
 * only the user's written text.
 */
function stripFileBlocks(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/<details><summary>Attached Files<\/summary>[\s\S]*?<\/details>/g, '')
    .replace(/<details><summary>[^<]+?<\/summary>[\s\S]*?<\/details>/g, '')
    .trim();
}

/**
 * Build a clickable chip for viewing a text file (read-only in sent messages).
 */
function buildFileChipView(name, content, editable = false, onSave) {
  const chip = document.createElement('div');
  chip.className = 'file-attachment-chip';
  chip.title = name;
  const lineCount = (content.match(/\n/g) || []).length + 1;
  chip.innerHTML = `
    <span class="chip-icon">📄</span>
    <div style="display:flex;flex-direction:column;min-width:0;">
      <span class="chip-name">${escHtml(name)}</span>
      <span class="chip-meta">${lineCount} line${lineCount !== 1 ? 's' : ''}</span>
    </div>`;
  chip.addEventListener('click', () => {
    import('./modals.js').then(m => m.openFileViewerModal({
      name,
      content,
      editable,
      onSave,
    }));
  });
  return chip;
}

// ── Builders ──────────────────────────────────────────────────────────────

function makeWrap(index) {
  const w = document.createElement('div');
  w.className = 'msg-group'; w.dataset.index = index;
  return w;
}

function buildActions(items, side = 'left') {
  const div = document.createElement('div');
  div.className = 'msg-actions' + (side === 'right' ? ' msg-actions-right' : ' msg-actions-left');
  items.forEach(({ icon, title, fn }) => {
    const btn = document.createElement('button');
    btn.className = 'msg-action-btn'; btn.title = title;
    btn.innerHTML = icon;
    btn.addEventListener('click', e => { e.stopPropagation(); fn(); });
    div.appendChild(btn);
  });
  return div;
}

function buildVersionNav(msg, index) {
  const nav     = document.createElement('div');
  nav.className = 'msg-version-nav';
  const total   = msg.versions.length;
  const cur     = (msg.currentVersionIdx ?? 0) + 1;

  const prev = document.createElement('button');
  prev.innerHTML = '&#8249;'; prev.title = 'Previous version'; prev.disabled = cur <= 1;
  prev.addEventListener('click', () => send({ type: 'chat:selectVersion',
    sessionId: activeSessionId, messageIndex: index, versionIdx: (msg.currentVersionIdx ?? 0) - 1 }));

  const lbl = document.createElement('span');
  lbl.textContent = `${cur} / ${total}`;
  lbl.style.cssText = 'min-width:36px;text-align:center;';

  const next = document.createElement('button');
  next.innerHTML = '&#8250;'; next.title = 'Next version'; next.disabled = cur >= total;
  next.addEventListener('click', () => send({ type: 'chat:selectVersion',
    sessionId: activeSessionId, messageIndex: index, versionIdx: (msg.currentVersionIdx ?? 0) + 1 }));

  nav.appendChild(prev); nav.appendChild(lbl); nav.appendChild(next);
  return nav;
}

function buildToolChip(call) {
  const names = { ollama_search: 'Web Search', read_web_page: 'Read Page',
    generate_image: 'Image Gen', generate_video: 'Video Gen', generate_audio: 'Audio Gen' };
  const icons = { ollama_search: '🔍', read_web_page: '📄',
    generate_image: '🖼️', generate_video: '🎬', generate_audio: '🎵' };
  const chip = document.createElement('button');
  chip.className = 'msg-tool-call';
  chip.innerHTML = `<span>${icons[call.name] || '🔧'}</span><span>${escHtml(names[call.name] || call.name)}</span>`;
  chip.addEventListener('click', () => import('./modals.js').then(m => m.showToolCallModal(call)));
  return chip;
}

function dlBtn(fn) {
  const btn = document.createElement('button');
  btn.className = 'media-download-btn'; btn.textContent = 'Download';
  btn.addEventListener('click', fn);
  return btn;
}

// ── SVG icons ─────────────────────────────────────────────────────────────

function copyIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

function editIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
}

function searchIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
}
function imageIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}
function videoIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`;
}
function audioIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
}
function attachIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
}
function sendSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21L23 12 2 3v7l15 2-15 2v7z"/></svg>`;
}

// ── Inline editing ────────────────────────────────────────────────────────

function extractAttachmentsFromContent(content) {
  if (!content || typeof content === 'string') {
    // Extract from embedded file blocks in text
    const files = msgFiles(typeof content === 'string' ? content : '');
    return files.map(f => ({ type: 'text', name: f.name, content: f.content }));
  }
  if (!Array.isArray(content)) return [];
  const attachments = [];
  content.forEach(item => {
    if (item.type === 'image_url' && item.image_url?.url) {
      const dataUrl = item.image_url.url;
      if (dataUrl.startsWith('data:')) {
        const comma = dataUrl.indexOf(',');
        if (comma > 0) {
          const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
          const base64 = dataUrl.slice(comma + 1);
          const ext = mimeType.split('/')[1] || 'png';
          attachments.push({ type: 'image', name: `image.${ext}`, base64, mimeType });
        }
      }
    }
  });
  // Also extract text files from text part
  const textPart = content.find(p => p.type === 'text')?.text || '';
  msgFiles(textPart).forEach(f => {
    attachments.push({ type: 'text', name: f.name, content: f.content });
  });
  return attachments;
}

/**
 * startUserEdit now accepts existingFiles extracted from the rendered message.
 */
function startUserEdit(wrap, index, msg, originalText, existingFiles = []) {
  const bubble = wrap.querySelector('.msg-user'); if (!bubble) return;
  const originalHTML = bubble.innerHTML;

  // Get clean text without embedded file blocks
  const cleanText = stripFileBlocks(originalText);

  bubble.innerHTML = '';
  bubble.classList.add('editing-user');

  // Textarea — show bullet characters correctly
  const ta = makeUserEditTextarea(cleanText);

  // Set up bullet auto-convert in the edit textarea
  setupEditBulletConvert(ta);

  bubble.appendChild(ta);

  // File preview row
  const editAttachments = [];
  // Start with existing image attachments
  const existingImages = extractAttachmentsFromContent(msg.content).filter(a => a.type === 'image');
  editAttachments.push(...existingImages);
  // Add existing text file attachments
  existingFiles.forEach(f => editAttachments.push({ type: 'text', name: f.name, content: f.content }));

  const filePreviewRow = document.createElement('div');
  filePreviewRow.className = 'edit-file-preview-row';
  bubble.appendChild(filePreviewRow);

  if (editAttachments.length > 0) renderEditFilePreview(editAttachments, filePreviewRow);

  // Bottom toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'edit-toolbar';

  const toolRow = document.createElement('div');
  toolRow.className = 'edit-tool-row';

  const toolDefs = [
    { key: 'webSearch', label: 'Search', icon: searchIcon() },
    { key: 'imageGen',  label: 'Image',  icon: imageIcon() },
    { key: 'videoGen',  label: 'Video',  icon: videoIcon() },
    { key: 'audioGen',  label: 'Audio',  icon: audioIcon() },
  ];

  toolDefs.forEach(({ key, label, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'tool-btn-sm edit-tool-btn';
    btn.dataset.tool = key;
    btn.title = label;
    btn.innerHTML = `${icon}<span>${label}</span>`;
    const mainBtn = document.querySelector(`#bottom-input-bar [data-tool="${key}"]`);
    if (mainBtn?.classList.contains('active')) btn.classList.add('active');
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    toolRow.appendChild(btn);
  });

  // Paste image in edit textarea
  ta.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const dataUrl = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result);
            reader.onerror = rej;
            reader.readAsDataURL(file);
          });
          const comma = dataUrl.indexOf(',');
          const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
          const base64 = dataUrl.slice(comma + 1);
          editAttachments.push({
            type: 'image',
            name: file.name || `image.${mimeType.split('/')[1] || 'png'}`,
            base64, mimeType,
          });
          renderEditFilePreview(editAttachments, filePreviewRow);
        }
      }
    }
  });

  // Attach button
  const attachBtn = document.createElement('button');
  attachBtn.className = 'edit-attach-btn';
  attachBtn.title = 'Attach file or image';
  attachBtn.innerHTML = attachIcon();
  attachBtn.addEventListener('click', e => {
    e.stopPropagation();
    openEditAttachMenu(e, attachBtn, editAttachments, filePreviewRow);
  });
  toolRow.appendChild(attachBtn);
  toolbar.appendChild(toolRow);

  // Cancel + Send
  const btnRow = document.createElement('div');
  btnRow.className = 'edit-btn-row';

  const cancelBtn = makeBtn('Cancel', 'btn-ghost');
  cancelBtn.addEventListener('click', () => {
    bubble.classList.remove('editing-user');
    bubble.innerHTML = originalHTML;
    attachCodeCopyListeners(bubble);
  });

  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn-primary edit-send-btn';
  sendBtn.innerHTML = `${sendSvg()} Send`;
  sendBtn.addEventListener('click', () => {
    const newContent = ta.value.trim(); if (!newContent && editAttachments.length === 0) return;
    sendBtn.disabled = true;

    const tools = {};
    toolbar.querySelectorAll('[data-tool]').forEach(b => {
      tools[b.dataset.tool] = b.classList.contains('active');
    });

    send({
      type: 'chat:editMessage',
      sessionId: activeSessionId,
      messageIndex: index,
      newContent: buildEditContent(newContent, editAttachments),
      role: 'user',
    });

    const handler = (editMsg) => {
      if (editMsg.sessionId !== activeSessionId || editMsg.messageIndex !== index) return;
      off('chat:messageEdited', handler);
      send({ type: 'chat:send', sessionId: activeSessionId, tools });
    };
    on('chat:messageEdited', handler);
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(sendBtn);
  toolbar.appendChild(btnRow);

  bubble.appendChild(toolbar);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function setupEditBulletConvert(ta) {
  ta.addEventListener('keydown', (e) => {
    const val = ta.value;
    const pos = ta.selectionStart;

    if (e.key === ' ') {
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const beforeCursor = val.slice(lineStart, pos);
      if (beforeCursor === '-') {
        e.preventDefault();
        const newVal = val.slice(0, lineStart) + BULLET + ' ' + val.slice(pos);
        ta.value = newVal;
        const newPos = lineStart + 2;
        ta.setSelectionRange(newPos, newPos);
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
        return;
      }
    }

    if (e.key === 'Backspace') {
      const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
      const beforeCursor = val.slice(lineStart, pos);
      if (beforeCursor === BULLET + ' ') {
        e.preventDefault();
        const newVal = val.slice(0, lineStart) + '- ' + val.slice(pos);
        ta.value = newVal;
        const newPos = lineStart + 2;
        ta.setSelectionRange(newPos, newPos);
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
        return;
      }
      if (beforeCursor === BULLET) {
        e.preventDefault();
        const newVal = val.slice(0, lineStart) + '-' + val.slice(pos);
        ta.value = newVal;
        const newPos = lineStart + 1;
        ta.setSelectionRange(newPos, newPos);
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      }
    }
  });
}

function buildEditContent(text, attachments) {
  const images = attachments.filter(a => a.type === 'image');
  const files  = attachments.filter(a => a.type === 'text');
  let fullText = text;
  if (files.length > 0) {
    fullText += '\n\n<details><summary>Attached Files</summary>\n';
    for (const f of files)
      fullText += `\n<details><summary>${f.name}</summary>\n\n\`\`\`\n${f.content}\n\`\`\`\n\n</details>\n`;
    fullText += '</details>';
  }
  if (images.length > 0) {
    return [
      { type: 'text', text: fullText },
      ...images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
    ];
  }
  return fullText;
}

function openEditAttachMenu(e, triggerEl, editAttachments, filePreviewRow) {
  e.preventDefault();
  const fileInput  = document.getElementById('file-input');
  const imageInput = document.getElementById('image-input');
  if (!fileInput || !imageInput) return;

  const menu = document.getElementById('attach-context-menu');
  if (!menu) return;
  menu.innerHTML = '';

  for (const item of [
    {
      label: '📄 Upload file',
      onClick: () => {
        const handler = async function() {
          for (const file of fileInput.files) {
            const text = await file.text();
            editAttachments.push({ type: 'text', name: file.name, content: text });
          }
          fileInput.value = '';
          fileInput.removeEventListener('change', handler);
          renderEditFilePreview(editAttachments, filePreviewRow);
        };
        fileInput.addEventListener('change', handler);
        fileInput.click();
      },
    },
    {
      label: '🖼️ Upload image',
      onClick: () => {
        const handler = async function() {
          for (const file of imageInput.files) {
            const dataUrl = await new Promise((res, rej) => {
              const reader = new FileReader();
              reader.onload  = () => res(reader.result);
              reader.onerror = rej;
              reader.readAsDataURL(file);
            });
            const comma = dataUrl.indexOf(',');
            const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
            const base64   = dataUrl.slice(comma + 1);
            editAttachments.push({ type: 'image', name: file.name, base64, mimeType });
          }
          imageInput.value = '';
          imageInput.removeEventListener('change', handler);
          renderEditFilePreview(editAttachments, filePreviewRow);
        };
        imageInput.addEventListener('change', handler);
        imageInput.click();
      },
    },
  ]) {
    const el = document.createElement('div');
    el.className = 'context-item'; el.textContent = item.label;
    el.addEventListener('click', () => { menu.classList.add('hidden'); item.onClick(); });
    menu.appendChild(el);
  }

  menu.classList.remove('hidden');
  const rect = triggerEl.getBoundingClientRect();
  const mh   = 80;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.top  = `${rect.top - mh - 8}px`;
  setTimeout(() => document.addEventListener('click', () => menu.classList.add('hidden'), { once: true }), 0);
}

function renderEditFilePreview(attachments, row) {
  row.innerHTML = '';
  if (attachments.length === 0) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.style.flexWrap = 'wrap';
  row.style.gap = '6px';
  attachments.forEach((a, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'attach-preview-item';
    if (a.type === 'image') {
      const img = document.createElement('img');
      img.src = `data:${a.mimeType};base64,${a.base64}`; img.alt = a.name;
      wrap.appendChild(img);
    } else {
      // Use the same nice chip for text files in edit mode
      const chip = buildFileChipView(a.name, a.content, true, (nc) => {
        attachments[i].content = nc;
      });
      wrap.appendChild(chip);
    }
    const rm = document.createElement('button');
    rm.className = 'attach-preview-remove'; rm.textContent = '×';
    rm.addEventListener('click', e => {
      e.stopPropagation();
      attachments.splice(i, 1);
      renderEditFilePreview(attachments, row);
    });
    wrap.appendChild(rm);
    row.appendChild(wrap);
  });
  renderFilePreviewRow();
}

function startAssistantEdit(wrap, index, msg) {
  const bubble = wrap.querySelector('.msg-assistant'); if (!bubble) return;
  const originalContent = msg.content || '';
  const originalHTML = bubble.innerHTML;

  bubble.classList.add('editing');
  bubble.innerHTML = '';

  const ta = makeAssistantEditTextarea(originalContent);
  bubble.appendChild(ta);

  const btns = document.createElement('div');
  btns.className = 'edit-actions';

  const cancelBtn = makeBtn('Cancel', 'btn-ghost');
  cancelBtn.addEventListener('click', () => {
    bubble.classList.remove('editing');
    bubble.innerHTML = originalHTML;
    attachCodeCopyListeners(bubble);
    attachSvgPanelListeners(bubble);
  });

  const saveBtn = makeBtn('Save', 'btn-primary');
  saveBtn.addEventListener('click', () => {
    const newContent = ta.value.trim(); if (!newContent) return;
    saveBtn.disabled = true;
    send({ type: 'chat:editMessage', sessionId: activeSessionId,
      messageIndex: index, newContent, role: 'assistant' });
  });

  btns.appendChild(cancelBtn); btns.appendChild(saveBtn);
  bubble.appendChild(btns);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function makeUserEditTextarea(value) {
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.cssText = [
    'width:100%',
    'background:transparent',
    'border:none',
    'outline:none',
    'color:var(--text)',
    'font:inherit',
    'font-size:15px',
    'resize:none',
    'line-height:1.6',
    'min-height:26px',
    'overflow-y:hidden',
    'display:block',
  ].join(';');
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return ta;
}

function makeAssistantEditTextarea(value) {
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.style.cssText = [
    'width:100%',
    'background:transparent',
    'border:none',
    'outline:none',
    'color:var(--text)',
    'font:inherit',
    'font-size:14px',
    'resize:none',
    'line-height:1.6',
    'min-height:120px',
    'overflow-y:auto',
    'display:block',
    'padding-bottom:8px',
  ].join(';');
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.6) + 'px';
  };
  ta.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return ta;
}

function makeBtn(label, cls) {
  const btn = document.createElement('button');
  btn.textContent = label; btn.className = cls;
  btn.style.cssText += ';font-size:12px;padding:5px 12px;';
  return btn;
}

// ── Streaming ─────────────────────────────────────────────────────────────

function onChatStart(msg) {
  const sessionId = msg.sessionId;
  isStreaming = true;
  streamingSessionId = sessionId;
  streamingText = '';
  pendingAssets = [];

  if (sessionId !== activeSessionId) {
    // Streaming for a background session — just track state, no UI
    return;
  }

  showChat();
  const box = document.getElementById('chat-messages'); if (!box) return;
  streamingBubble = document.createElement('div');
  streamingBubble.className = 'msg-assistant msg-generating';

  const thinking = document.createElement('div'); thinking.className = 'msg-thinking';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('div'); d.className = 'thinking-dot'; thinking.appendChild(d);
  }
  streamingBubble.appendChild(thinking);
  box.appendChild(streamingBubble);
  if (autoScroll) box.scrollTop = box.scrollHeight;
  updateSendBtn(true);
}

function onToken(token) {
  if (!streamingBubble) return;
  streamingText += token;
  streamingBubble.querySelector('.msg-thinking')?.remove();
  const displayText = stripSessionTag(processDisplay(streamingText));
  streamingBubble.innerHTML = renderMarkdown(displayText);
  attachCodeCopyListeners(streamingBubble);
  if (autoScroll) {
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }
}

function onChatDone(msg) {
  const sessionId = msg.sessionId;
  if (sessionId === streamingSessionId) {
    isStreaming = false;
    streamingSessionId = null;
  }

  if (sessionId === activeSessionId) {
    streamingBubble?.classList.remove('msg-generating');
    streamingBubble = null;
    streamingText = '';
    updateSendBtn(false);
    if (msg.history) {
      renderHistory(msg.history);
      if (pendingAssets.length > 0) {
        const box = document.getElementById('chat-messages');
        if (box) {
          pendingAssets.forEach(asset => appendMediaMsg(box, asset.role, asset.content));
          if (autoScroll) box.scrollTop = box.scrollHeight;
        }
        pendingAssets = [];
      }
    }
  }
}

function onChatAborted(msg) {
  const sessionId = msg.sessionId;
  if (sessionId === streamingSessionId) {
    isStreaming = false;
    streamingSessionId = null;
  }

  if (sessionId === activeSessionId) {
    if (streamingBubble) {
      streamingBubble.classList.remove('msg-generating');
      const note = document.createElement('div');
      note.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:6px;';
      note.textContent = '⚠ Interrupted';
      streamingBubble.appendChild(note);
      streamingBubble = null;
    }
    updateSendBtn(false);
    if (msg.history) {
      renderHistory(msg.history);
      if (pendingAssets.length > 0) {
        const box = document.getElementById('chat-messages');
        if (box) pendingAssets.forEach(asset => appendMediaMsg(box, asset.role, asset.content));
      }
    }
    pendingAssets = [];
  }
}

function onChatError(err) {
  isStreaming = false;
  streamingSessionId = null;
  if (streamingBubble) {
    streamingBubble.classList.remove('msg-generating');
    streamingBubble.querySelector('.msg-thinking')?.remove();
    const note = document.createElement('div');
    note.style.cssText = 'color:#f87171;font-size:13px;margin-top:6px;';
    note.textContent = `⚠ Error: ${err}`;
    streamingBubble.appendChild(note);
    streamingBubble = null;
  }
  updateSendBtn(false);
}

function handleLiveToolCall(call) {
  if (!streamingBubble) return;
  const names = { ollama_search: 'Searching web…', read_web_page: 'Reading page…',
    generate_image: 'Generating image…', generate_video: 'Generating video…', generate_audio: 'Generating audio…' };

  if (call.state === 'pending') {
    streamingBubble.querySelector('.msg-thinking')?.remove();
    if (!streamingBubble.querySelector(`[data-tcid="${call.id}"]`)) {
      const badge = document.createElement('div'); badge.className = 'msg-tool-call';
      badge.style.pointerEvents = 'none'; badge.setAttribute('data-tcid', call.id);
      badge.innerHTML = `<span>🔧</span><span>${names[call.name] || call.name}</span>`;
      streamingBubble.appendChild(badge);
    }
  } else if (call.state === 'resolved' || call.state === 'canceled') {
    streamingBubble.querySelector(`[data-tcid="${call.id}"]`)?.remove();
  }
}

function appendAsset(asset) {
  const box = document.getElementById('chat-messages'); if (!box) return;
  pendingAssets.push(asset);
  appendMediaMsg(box, asset.role, asset.content);
  if (autoScroll) box.scrollTop = box.scrollHeight;
}

// ── Submit ────────────────────────────────────────────────────────────────

export function submitMessage(text, attachments = []) {
  if (!text.trim() && attachments.length === 0) return;
  if (isStreaming && streamingSessionId === activeSessionId) {
    send({ type: 'chat:stop', sessionId: activeSessionId });
    return;
  }
  if (!activeSessionId) return;

  const images   = attachments.filter(a => a.type === 'image');
  const textFiles= attachments.filter(a => a.type === 'text');

  let fullText = text;
  if (textFiles.length > 0) {
    fullText += '\n\n<details><summary>Attached Files</summary>\n';
    for (const f of textFiles)
      fullText += `\n<details><summary>${f.name}</summary>\n\n\`\`\`\n${f.content}\n\`\`\`\n\n</details>\n`;
    fullText += '</details>';
  }

  let content;
  if (images.length > 0) {
    content = [
      { type: 'text', text: fullText },
      ...images.map(img => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
    ];
  } else {
    content = fullText;
  }

  // Append optimistic user bubble
  const box = document.getElementById('chat-messages');
  if (box) {
    const wrap = makeWrap(-1);
    const bubble = document.createElement('div'); bubble.className = 'msg-user';
    const displayText = textWithBullets(stripFileBlocks(text));
    bubble.innerHTML = renderMarkdown(displayText);
    images.forEach(img => {
      const el = document.createElement('img');
      el.src = `data:${img.mimeType};base64,${img.base64}`;
      el.style.cssText = 'max-width:100%;max-height:200px;border-radius:8px;margin-top:6px;display:block;';
      bubble.appendChild(el);
    });
    if (textFiles.length > 0) {
      const fileRow = document.createElement('div');
      fileRow.className = 'msg-file-attachments';
      textFiles.forEach(f => fileRow.appendChild(buildFileChipView(f.name, f.content, false)));
      bubble.appendChild(fileRow);
    }
    wrap.appendChild(bubble);
    box.appendChild(wrap);
    if (autoScroll) box.scrollTop = box.scrollHeight;
  }

  send({ type: 'chat:send', sessionId: activeSessionId, content, tools: getActiveTools(), clientId: localStorage.getItem('ipai_client_id') || '' });
}

// ── Utils ─────────────────────────────────────────────────────────────────

function getActiveTools() {
  const tools = {};
  const container =
    document.querySelector('#bottom-input-bar:not(.hidden)')?.querySelector('.tool-row') ||
    document.querySelector('.center-input-actions');

  if (!container) {console.warn('Tool container not found'); return tools;};

  container.querySelectorAll('[data-tool]').forEach(btn => {
    const toolName = btn.dataset.tool;
    if (toolName) tools[toolName] = btn.classList.contains('active');
  });

  return tools;
}

function msgText(content) {
  if (typeof content === 'string') return content;
  return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}
function msgImages(content) {
  if (typeof content === 'string') return [];
  return content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
}

/**
 * Convert bullet characters (•) back to markdown list items for rendering.
 * This ensures the display text renders as proper bullet points via marked.js
 */
function textWithBullets(text) {
  if (!text) return text;
  // Convert '• ' at start of line to '* ' for markdown rendering
  return text.replace(/^(\s*)\u2022\s/gm, '$1* ');
}

function processDisplay(text) {
  let result = '', i = 0;
  while (i < text.length) {
    const start = text.indexOf('```svg', i);
    if (start === -1) { result += text.slice(i); break; }
    result += text.slice(i, start) + '[SVG Image]';
    const end = text.indexOf('```', start + 6);
    if (end === -1) break;
    i = end + 3;
  }
  return result;
}

function updateSendBtn(streaming) {
  const sessionStreaming = streaming && (streamingSessionId === activeSessionId || streaming === true);
  document.querySelectorAll('#bottom-send-btn, #center-send-btn').forEach(btn => {
    btn.innerHTML = sessionStreaming
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21L23 12 2 3v7l15 2-15 2v7z"/></svg>';
    btn.classList.toggle('stop', !!sessionStreaming);
  });
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => showNotification({ type: 'success', message: 'Copied', duration: 1500 }),
    () => showNotification({ type: 'error',   message: 'Copy failed', duration: 1500 })
  );
}

function dlMedia(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function openImageModal(src) {
  import('./modals.js').then(m => m.openImageModal(src));
}

// Scroll tracking
document.getElementById('chat-view')?.addEventListener('scroll', e => {
  const el = e.target;
  autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}, true);