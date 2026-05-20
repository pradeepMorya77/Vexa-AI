// ========================================
// DeepKul-AI - DB-backed Chat UI
// ========================================
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const newChatBtn = document.getElementById('newChatBtn');
const chatHistory = document.getElementById('chatHistory');
const chatContainer = document.getElementById('chatContainer');
const welcomeScreen = document.getElementById('welcomeScreen');
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const suggestionCards = document.querySelectorAll('.suggestion-card');
const renameModal = document.getElementById('renameModal');
const renameInput = document.getElementById('renameInput');
const renameConfirm = document.getElementById('renameConfirm');
const renameCancel = document.getElementById('renameCancel');
const renameCancelBtn = document.getElementById('renameCancelBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');

let currentChatId = null;
let chats = [];
let isStreaming = false;
let abortController = null;
let renamingChatId = null;

const synapseIcon = `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
  <path d="M2 17l10 5 10-5"></path>
  <path d="M2 12l10 5 10-5"></path>
</svg>`;

document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupFileUpload();
  autoResizeTextarea();
  await loadChatsFromServer();
});

function setupEventListeners() {
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);
  if (newChatBtn) newChatBtn.addEventListener('click', startNewChat);
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  if (stopBtn) stopBtn.addEventListener('click', stopStreaming);
  if (messageInput) {
    messageInput.addEventListener('input', handleInputChange);
    messageInput.addEventListener('keydown', handleKeyDown);
  }
  suggestionCards.forEach(card => {
    card.addEventListener('click', () => {
      messageInput.value = card.dataset.prompt || '';
      handleInputChange();
      sendMessage();
    });
  });
  if (renameConfirm) renameConfirm.addEventListener('click', confirmRename);
  if (renameCancel) renameCancel.addEventListener('click', closeRenameModal);
  if (renameCancelBtn) renameCancelBtn.addEventListener('click', closeRenameModal);
  if (renameInput) {
    renameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirmRename();
      if (e.key === 'Escape') closeRenameModal();
    });
  }
  const backdrop = renameModal?.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeRenameModal);
}

function setupFileUpload() {
  if (!uploadBtn || !fileInput) return;
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileSelect);
  const inputWrapper = document.querySelector('.input-wrapper');
  if (!inputWrapper) return;
  inputWrapper.addEventListener('dragover', e => { e.preventDefault(); uploadBtn.classList.add('uploading'); });
  inputWrapper.addEventListener('dragleave', () => uploadBtn.classList.remove('uploading'));
  inputWrapper.addEventListener('drop', e => {
    e.preventDefault();
    uploadBtn.classList.remove('uploading');
    fileInput.files = e.dataTransfer.files;
    handleFileSelect();
  });
}

async function handleFileSelect() {
  const files = fileInput.files;
  if (!files.length) return;
  
  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  if (currentChatId) formData.append('chat_id', currentChatId);

  const originalIcon = uploadBtn.innerHTML;
  uploadBtn.classList.add('uploading');
  uploadBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"></path></svg>`;
  
  try {
    const response = await fetch('/upload', { method: 'POST', body: formData, credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    
    // Add uploaded file card as a user message in the chat
    if (data.files && data.files.length > 0) {
      if (!currentChatId) {
        welcomeScreen.style.display = 'none';
        chatMessages.classList.add('active');
      }
      
      // Show file upload card for each uploaded file
      data.files.forEach(file => {
        if (file.status === 'ok') {
          appendFileCard(file.filename);
        }
      });
    }
  } catch (err) {
    appendMessage('bot', `Upload failed: ${err.message}`, true);
  } finally {
    uploadBtn.classList.remove('uploading');
    uploadBtn.innerHTML = originalIcon;
    fileInput.value = '';
  }
}

function appendFileCard(filename) {
  // """Append uploaded file as a user-side message card in the chat"""
  const messageEl = document.createElement('div');
  messageEl.className = 'message user';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  messageEl.innerHTML = `
    <div class="message-avatar">U</div>
    <div class="message-content">
      <div class="message-bubble file-upload-card">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="file-icon">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <div class="file-info">
          <div class="file-name">${escapeHtml(filename)}</div>
          <div class="file-status">File uploaded</div>
        </div>
      </div>
      <div class="message-meta">
        <span>${time}</span>
      </div>
    </div>`;
  
  chatMessages.appendChild(messageEl);
  scrollToBottom();
}

async function loadChatsFromServer() {
  try {
    const res = await fetch('/api/chats', { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
    chats = data.chats || [];
    renderChatHistory();
  } catch (e) {
    console.error('Failed to load chats', e);
  }
}

function renderChatHistory() {
  chatHistory.innerHTML = '';
  chats.forEach(chat => {
    const item = document.createElement('button');
    item.className = 'chat-history-item' + (String(chat.id) === String(currentChatId) ? ' active' : '');
    item.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      <span class="chat-history-item-text">${escapeHtml(chat.title)}</span>
      <div class="chat-history-item-actions">
        <button class="chat-action-btn rename-btn" title="Rename" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg></button>
        <button class="chat-action-btn delete-btn" title="Delete" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
      </div>`;
    item.addEventListener('click', () => loadChat(chat.id));
    item.querySelector('.rename-btn').addEventListener('click', e => startRenameChat(chat.id, chat.title, e));
    item.querySelector('.delete-btn').addEventListener('click', e => { e.stopPropagation(); deleteChat(chat.id); });
    chatHistory.appendChild(item);
  });
}

function startNewChat() {
  currentChatId = null;
  chatMessages.innerHTML = '';
  chatMessages.classList.remove('active');
  welcomeScreen.style.display = 'flex';
  messageInput.value = '';
  handleInputChange();
  renderChatHistory();
  closeSidebar();
}

async function loadChat(chatId) {
  currentChatId = chatId;
  welcomeScreen.style.display = 'none';
  chatMessages.classList.add('active');
  chatMessages.innerHTML = '';
  try {
    const res = await fetch(`/api/chats/${chatId}/messages`, { credentials: 'same-origin' });
    const data = await res.json();
    (data.messages || []).forEach(msg => appendMessage(msg.role, msg.content, false));
  } catch (e) {
    appendMessage('bot', 'Failed to load chat messages.', false);
  }
  renderChatHistory();
  scrollToBottom();
  closeSidebar();
}

async function deleteChat(chatId) {
  if (!confirm('Delete this chat?')) return;
  await fetch(`/api/chats/${chatId}`, { method: 'DELETE', credentials: 'same-origin' });
  if (String(currentChatId) === String(chatId)) startNewChat();
  await loadChatsFromServer();
}

function startRenameChat(chatId, title, event) {
  event.stopPropagation();
  renamingChatId = chatId;
  renameInput.value = title || '';
  renameModal.classList.add('visible');
  renameInput.focus();
  renameInput.select();
}

async function confirmRename() {
  const newTitle = renameInput.value.trim();
  if (!renamingChatId || !newTitle) return;
  await fetch(`/api/chats/${renamingChatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ title: newTitle })
  });
  closeRenameModal();
  await loadChatsFromServer();
}

function closeRenameModal() {
  renameModal.classList.remove('visible');
  renamingChatId = null;
  renameInput.value = '';
}

function handleInputChange() {
  const hasText = messageInput.value.trim().length > 0;
  sendBtn.disabled = !hasText || isStreaming;
  autoResizeTextarea();
}

function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) sendMessage(); }
}

function autoResizeTextarea() {
  if (!messageInput) return;
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || isStreaming) return;

  if (!currentChatId) {
    welcomeScreen.style.display = 'none';
    chatMessages.classList.add('active');
  }

  appendMessage('user', message);
  messageInput.value = '';
  handleInputChange();
  const typingIndicator = showTypingIndicator();
  isStreaming = true;
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  abortController = new AbortController();

  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message, chat_id: currentChatId }),
      signal: abortController.signal
    });
    if (response.status === 401) { window.location.href = '/login'; return; }
    if (!response.ok) throw new Error('Request failed');
    typingIndicator.remove();
    const botMessageEl = appendMessage('bot', '', false);
    const bubbleEl = botMessageEl.querySelector('.message-bubble');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let botResponse = '';
    let buffer = '';
    let updateScheduled = false;

    const scheduleUpdate = () => {
      if (updateScheduled) return;
      updateScheduled = true;
      requestAnimationFrame(() => {
        if (buffer.length) {
          botResponse += buffer;
          bubbleEl.innerHTML = formatMessage(botResponse);
          buffer = '';
          scrollToBottom();
        }
        updateScheduled = false;
      });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.chat_id && !currentChatId) currentChatId = data.chat_id;
          if (data.error) { bubbleEl.innerHTML = `<div class="error-message">${escapeHtml(data.error)}</div>`; break; }
          if (data.token) { buffer += data.token; scheduleUpdate(); }
          if (data.done) {
            botResponse += buffer;
            bubbleEl.innerHTML = formatMessage(botResponse);
            buffer = '';
            updateScheduled = false;
            await loadChatsFromServer();
            break;
          }
        } catch {}
      }
    }
  } catch (error) {
    typingIndicator.remove();
    if (error.name !== 'AbortError') appendMessage('bot', 'Unable to connect. Please ensure backend is running.', true);
  } finally {
    isStreaming = false;
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    abortController = null;
    handleInputChange();
  }
}

function stopStreaming() { if (abortController) abortController.abort(); }

function appendMessage(role, content, animate = true) {
  const messageEl = document.createElement('div');
  messageEl.className = `message ${role}`;
  const avatarText = role === 'user' ? 'U' : synapseIcon;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const copyButton = role === 'bot' ? `
    <button class="copy-btn" title="Copy response" aria-label="Copy response" type="button">
      <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </button>` : '';

  messageEl.innerHTML = `
    <div class="message-avatar">${avatarText}</div>
    <div class="message-content">
      <div class="message-bubble">${formatMessage(content)}</div>
      <div class="message-meta">
        <span>${time}</span>
        ${copyButton}
      </div>
    </div>`;

  const copyBtn = messageEl.querySelector('.copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      
      const bubbleEl = messageEl.querySelector('.message-bubble');
      if (!bubbleEl) {
        console.error('[v0] Copy: message bubble not found');
        showCopyError(copyBtn, 'Error: Content not found');
        return;
      }
      
      // Extract text using multiple methods for maximum compatibility
      const text = extractTextContent(bubbleEl);
      
      if (!text || text.trim().length === 0) {
        console.warn('[v0] Copy: no text content available');
        showCopyError(copyBtn, 'No content to copy');
        return;
      }
      
      try {
        // Primary method: Modern Clipboard API
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          showCopySuccess(copyBtn);
        } else {
          // Fallback: execCommand method for older browsers
          copyTextFallback(text);
          showCopySuccess(copyBtn);
        }
      } catch (err) {
        console.error('[v0] Copy via clipboard failed:', err);
        // Try fallback method
        try {
          copyTextFallback(text);
          showCopySuccess(copyBtn);
        } catch (fallbackErr) {
          console.error('[v0] Copy fallback also failed:', fallbackErr);
          showCopyError(copyBtn, 'Copy failed. Try right-click instead.');
        }
      }
    });
  }
  
  chatMessages.appendChild(messageEl);
  if (animate) scrollToBottom();
  return messageEl;
}

function showTypingIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML = `<div class="message-avatar">${synapseIcon}</div><div class="message-content"><div class="message-bubble"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>`;
  chatMessages.appendChild(indicator);
  scrollToBottom();
  return indicator;
}

function formatMessage(text) {
  if (!text) return '';
  let formatted = escapeHtml(text);
  formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  formatted = formatted.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/(?<!\*)\*([^\*]+)\*(?!\*)/g, '<em>$1</em>');
  formatted = formatted.replace(/\n/g, '<br>');
  return formatted;
}

function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }
function scrollToBottom() { chatContainer.scrollTop = chatContainer.scrollHeight; }
function toggleSidebar() { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('visible'); }
function closeSidebar() { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('visible'); }

/**
 * Extract plain text from an element, handling formatted content properly
 * Priority: innerText > textContent (handles visibility and layout)
 */
function extractTextContent(element) {
  if (!element) return '';
  
  // Create a clone to avoid modifying the original
  const clone = element.cloneNode(true);
  
  // Handle code blocks specially
  const codeBlocks = clone.querySelectorAll('code');
  codeBlocks.forEach(code => {
    if (code.parentElement.tagName === 'PRE') {
      // For code blocks, preserve formatting
      const content = code.textContent;
      const newLine = document.createElement('div');
      newLine.textContent = content;
      code.parentElement.replaceWith(newLine);
    }
  });
  
  // Remove line break elements and preserve content
  const brElements = clone.querySelectorAll('br');
  brElements.forEach(br => {
    br.replaceWith('\n');
  });
  
  // Primary method: innerText (respects visibility and layout)
  if (clone.innerText) {
    return clone.innerText.trim();
  }
  
  // Fallback: textContent (simple text extraction)
  return clone.textContent.trim();
}

/**
 * Fallback method for copying text using execCommand
 * Works in older browsers that don't support Clipboard API
 */
function copyTextFallback(text) {
  // Create temporary textarea
  const textarea = document.createElement('textarea');
  
  // Set styling to make it invisible but keep it in DOM
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '-9999px',
    left: '-9999px',
    opacity: '0',
    pointerEvents: 'none',
    userSelect: 'text'
  });
  
  textarea.value = text;
  document.body.appendChild(textarea);
  
  try {
    // Select all text in textarea
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    
    // Execute copy command
    const success = document.execCommand('copy');
    if (!success) {
      throw new Error('execCommand copy failed');
    }
    console.log('[v0] Copy via execCommand succeeded');
  } finally {
    // Clean up
    document.body.removeChild(textarea);
  }
}

/**
 * Show success state with visual feedback
 */
function showCopySuccess(copyBtn) {
  console.log('[v0] Copy successful');
  copyBtn.classList.add('copied');
  copyBtn.setAttribute('title', 'Copied!');
  
  // Announce to screen readers
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.className = 'sr-only';
  announcement.textContent = 'Copied to clipboard';
  document.body.appendChild(announcement);
  
  setTimeout(() => {
    copyBtn.classList.remove('copied');
    copyBtn.setAttribute('title', 'Copy response');
    document.body.removeChild(announcement);
  }, 2000);
}

/**
 * Show error state with visual feedback
 */
function showCopyError(copyBtn, message) {
  console.error('[v0] Copy error:', message);
  copyBtn.classList.add('copy-error');
  copyBtn.setAttribute('title', message);
  
  // Announce to screen readers
  const announcement = document.createElement('div');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.className = 'sr-only';
  announcement.textContent = message;
  document.body.appendChild(announcement);
  
  setTimeout(() => {
    copyBtn.classList.remove('copy-error');
    copyBtn.setAttribute('title', 'Copy response');
    document.body.removeChild(announcement);
  }, 2000);
}
