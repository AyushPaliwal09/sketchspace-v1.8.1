'use strict';

(() => {
  const DB_NAME = 'sketchspace-local-v3';
  const DB_VERSION = 1;
  const COLORS = ['#d4d4d4', '#ffffff', '#4ec9b0', '#569cd6', '#f48771', '#dcdcaa', '#ce9178', '#9cdcfe'];
  const $ = (id) => document.getElementById(id);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll('-', '').slice(0, 14) : Math.random().toString(36).slice(2, 16));
  const clone = (x) => structuredClone(x);
  const now = () => Date.now();
  const app = {
    view: 'home', notes: [], activeId: null, title: 'Untitled canvas', elements: [], selectedId: null, selectedIds: [], canvasBackground: '#111111', canvasBackgroundMode: 'theme',
    tool: 'select', color: '#d4d4d4', size: 3, theme: localStorage.getItem('ss-theme') || 'dark', grid: true, inlineText: null, canvasLocked: false,
    zoom: 1, panX: 0, panY: 0, undoStack: [], redoStack: [], pendingSave: null, saveTimer: null,
    drawing: null, drag: null, preview: null, pointerId: null, spaceHeld: false, startPan: null, lastPointer: null,
    db: null, roomId: '', displayName: '', members: [], ws: null, roomJoinPending: false,
    library: [], remoteCursors: new Map(), cursorTimer: null, lastCursorSent: 0, lastSceneSent: 0,
    suppressSave: false, statusTimer: null, toastTimer: null, resizeObserver: null,
  };
  const canvas = $('drawing-canvas');
  $('canvas-viewport').setAttribute('tabindex', '0');
  const ctx = canvas.getContext('2d', { alpha: false });
  const viewport = $('canvas-viewport');
  const activePointers = new Map();
  let touchGesture = null;
  let lastTouchTap = null;
  let suppressNativeDoubleClickUntil = 0;

  function openDB() {
    if (app.db) return Promise.resolve(app.db);
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not supported in this browser.'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('library')) db.createObjectStore('library', { keyPath: 'id' });
      };
      request.onsuccess = () => { app.db = request.result; resolve(app.db); };
      request.onerror = () => reject(request.error || new Error('Could not open local database.'));
    });
  }
  async function dbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error);
    });
  }
  async function dbPut(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  async function dbDelete(store, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  }
  function defaultCanvasBackground() { return app.theme === 'dark' ? '#111111' : '#ffffff'; }
  function validHexColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
  function canvasBackgroundModeFor(note) {
    if (note?.backgroundMode === 'custom') return 'custom';
    if (note?.backgroundMode === 'theme') return 'theme';
    // Older notes did not store the mode. Treat the former default canvas colors as theme-following,
    // while keeping any clearly custom colors intact.
    const background = String(note?.background || '').toLowerCase();
    return !background || ['#111111', '#ffffff', '#1e1e1e', '#f3f3f3'].includes(background) ? 'theme' : 'custom';
  }
  function canvasBackgroundForNote(note) {
    const mode = canvasBackgroundModeFor(note);
    return mode === 'theme' ? defaultCanvasBackground() : (validHexColor(note?.background) ? note.background : defaultCanvasBackground());
  }
  function updateCanvasBackgroundControls() {
    const picker = $('canvas-bg-color');
    if (picker && validHexColor(app.canvasBackground)) picker.value = app.canvasBackground;
    const followButton = $('canvas-bg-follow-theme');
    if (followButton) {
      followButton.classList.toggle('hidden', app.canvasBackgroundMode !== 'custom');
      followButton.setAttribute('aria-pressed', String(app.canvasBackgroundMode === 'theme'));
      followButton.title = 'Use a canvas background that follows the light/dark theme';
      followButton.setAttribute('aria-label', followButton.title);
      const icon = followButton.querySelector('.action-icon');
      if (icon) icon.innerHTML = ICONS.theme || '';
    }
  }
  function makeNote(title = 'Untitled canvas') { return { id: uid(), title, elements: [], background: defaultCanvasBackground(), backgroundMode: 'theme', createdAt: now(), updatedAt: now() }; }
  function sanitizeFilename(value) { return (value || 'sketchspace').trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'sketchspace'; }
  function showToast(message, duration = 2400) {
    const t = $('toast'); if (!t) return;
    t.textContent = message; t.classList.remove('hidden'); clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
  }
  function setStatus(message, mode = '') {
    const el = $('saved-status'); el.className = `saved-status ${mode}`; el.querySelector('span').textContent = message;
  }
  function setTheme(theme) {
    const nextTheme = theme === 'light' ? 'light' : 'dark';
    const changed = app.theme !== nextTheme;
    app.theme = nextTheme; document.documentElement.dataset.theme = nextTheme; localStorage.setItem('ss-theme', nextTheme);
    const glyph = nextTheme === 'dark' ? ICONS.sun : ICONS.moon; $('theme-home').innerHTML = glyph; $('theme-editor').innerHTML = glyph;
    document.querySelector('meta[name="theme-color"]').content = nextTheme === 'dark' ? '#1e1e1e' : '#f3f3f3';
    // Every actual UI theme switch also switches the active canvas paper to the matching default:
    // dark = near-black, light = white. A manually chosen color remains until the next theme switch.
    if (changed) {
      app.canvasBackgroundMode = 'theme';
      app.canvasBackground = defaultCanvasBackground();
      const activeNote = app.activeId ? localNoteForActive() : null;
      if (activeNote) { activeNote.background = app.canvasBackground; activeNote.backgroundMode = 'theme'; activeNote.updatedAt = now(); }
      if (app.activeId && app.view === 'editor') scheduleSave();
    } else if (app.canvasBackgroundMode !== 'custom') {
      app.canvasBackgroundMode = 'theme';
      app.canvasBackground = defaultCanvasBackground();
    }
    updateCanvasBackgroundControls();
    redraw(); renderDashboard();
  }
  function setCanvasLocked(locked) {
    app.canvasLocked = !!locked;
    const button = $('toggle-canvas-lock');
    if (button) {
      button.classList.toggle('active', app.canvasLocked);
      button.setAttribute('aria-pressed', String(app.canvasLocked));
      button.title = app.canvasLocked ? 'Unlock canvas editing' : 'Lock canvas editing';
      button.setAttribute('aria-label', button.title);
      const glyph = button.querySelector('.tool-glyph');
      if (glyph) glyph.innerHTML = app.canvasLocked ? (ICONS['lock'] || '') : (ICONS['lock-open'] || ICONS.lock || '');
    }
    const hint = $('tool-hint');
    if (hint) hint.textContent = app.canvasLocked ? 'Canvas locked · pan and zoom still work · click the lock to unlock editing' : (app.tool === 'select' ? 'Select and move · double-click empty canvas to type · Delete removes selection' : hint.textContent);
    updateCanvasCursor();
  }
  function switchView(view) {
    app.view = view; $('dashboard').classList.toggle('hidden', view !== 'home'); $('home-topbar').classList.toggle('hidden', view !== 'home'); $('editor').classList.toggle('hidden', view !== 'editor');
    if (view === 'editor') { requestAnimationFrame(() => { resizeCanvas(); redraw(); }); }
  }
  async function loadAllNotes() {
    try { app.notes = (await dbGetAll('notes')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
    catch (err) { app.notes = []; showToast('Local storage is unavailable. Try another browser profile.'); }
    renderDashboard();
  }
  async function loadLibrary() {
    try { app.library = await dbGetAll('library'); }
    catch { app.library = []; }
  }
  function localNoteForActive() { return app.notes.find(n => n.id === app.activeId); }
  function scheduleSave() {
    if (app.suppressSave || !app.activeId) return;
    setStatus('Saving…', 'saving'); clearTimeout(app.saveTimer);
    app.saveTimer = setTimeout(saveActive, 280);
  }
  async function saveActive() {
    if (!app.activeId) return;
    const existing = localNoteForActive() || makeNote(app.title);
    const note = { ...existing, id: app.activeId, title: app.title.trim() || 'Untitled canvas', elements: clone(app.elements), background: app.canvasBackground || defaultCanvasBackground(), backgroundMode: app.canvasBackgroundMode || 'theme', updatedAt: now() };
    try {
      await dbPut('notes', note);
      const idx = app.notes.findIndex(n => n.id === note.id);
      if (idx >= 0) app.notes[idx] = note; else app.notes.unshift(note);
      app.notes.sort((a, b) => b.updatedAt - a.updatedAt);
      setStatus('Saved on this device');
      if (app.view === 'home') renderDashboard();
    } catch (err) { setStatus('Save failed', 'error'); showToast('Could not save this canvas locally. Export a backup to avoid losing work.'); }
  }
  function snapshotHistory() {
    app.undoStack.push(clone(app.elements));
    if (app.undoStack.length > 80) app.undoStack.shift();
    app.redoStack = []; updateHistoryButtons();
  }
  function mutate(next, options = {}) {
    if (options.history !== false) snapshotHistory();
    app.elements = next; renderLayerPanel(); redraw(); scheduleSave(); broadcastScene(); updateCounts();
  }
  function undo() {
    if (!app.undoStack.length) return;
    app.redoStack.push(clone(app.elements)); app.elements = app.undoStack.pop(); app.selectedId = null; app.selectedIds = []; app.selectedIds = [];
    updateHistoryButtons(); chooseSelected(null); scheduleSave(); broadcastScene(); updateCounts();
  }
  function redo() {
    if (!app.redoStack.length) return;
    app.undoStack.push(clone(app.elements)); app.elements = app.redoStack.pop(); app.selectedId = null; app.selectedIds = [];
    updateHistoryButtons(); chooseSelected(null); scheduleSave(); broadcastScene(); updateCounts();
  }
  function updateHistoryButtons() { $('undo').disabled = !app.undoStack.length; $('redo').disabled = !app.redoStack.length; }
  async function createNote(title) {
    const note = makeNote(title || 'Untitled canvas');
    await dbPut('notes', note); app.notes.unshift(note); app.activeId = note.id; app.title = note.title; app.elements = []; app.canvasBackgroundMode = 'theme'; app.canvasBackground = defaultCanvasBackground(); updateCanvasBackgroundControls();
    app.selectedId = null; app.selectedIds = []; app.undoStack = []; app.redoStack = []; app.panX = 0; app.panY = 0; app.zoom = 1;
    $('document-title').value = note.title; switchView('editor'); chooseSelected(null); updateCounts(); renderLayerPanel(); setStatus('Saved on this device');
    requestAnimationFrame(() => { resizeCanvas(); redraw(); }); return note;
  }
  function openNote(note) {
    app.activeId = note.id; app.title = note.title || 'Untitled canvas'; app.elements = clone(note.elements || []); app.canvasBackgroundMode = canvasBackgroundModeFor(note); app.canvasBackground = canvasBackgroundForNote(note); updateCanvasBackgroundControls();
    app.selectedId = null; app.selectedIds = []; app.undoStack = []; app.redoStack = []; app.panX = 0; app.panY = 0; app.zoom = 1;
    $('document-title').value = app.title; switchView('editor'); chooseSelected(null); updateCounts(); renderLayerPanel(); updateHistoryButtons(); setStatus('Saved on this device');
    requestAnimationFrame(() => { resizeCanvas(); redraw(); });
  }
  async function goHome() {
    if (app.view === 'editor') await saveActive();
    disconnectRoom(false); app.activeId = null; app.title = 'Untitled canvas'; app.elements = []; app.selectedId = null; app.selectedIds = [];
    await loadAllNotes(); switchView('home');
  }
  async function renameNote(note) {
    const title = prompt('Canvas name', note.title || 'Untitled canvas');
    if (!title || !title.trim()) return;
    note.title = title.trim(); note.updatedAt = now(); await dbPut('notes', note); await loadAllNotes();
    if (app.activeId === note.id) { app.title = note.title; $('document-title').value = note.title; }
  }
  async function duplicateNote(note) {
    const copyNote = { ...clone(note), id: uid(), title: `${note.title || 'Untitled canvas'} copy`, createdAt: now(), updatedAt: now() };
    await dbPut('notes', copyNote); await loadAllNotes(); showToast('Canvas duplicated locally.');
  }
  async function deleteNote(note) {
    if (!confirm(`Delete “${note.title || 'Untitled canvas'}” from this browser? This cannot be undone.`)) return;
    await dbDelete('notes', note.id);
    if (app.activeId === note.id) { app.activeId = null; app.elements = []; switchView('home'); }
    await loadAllNotes(); showToast('Canvas deleted from this device.');
  }

  function miniPreview(canvasEl, elements, background) {
    const box = canvasEl.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(box.width * dpr)), h = Math.max(1, Math.round(box.height * dpr));
    canvasEl.width = w; canvasEl.height = h;
    const c = canvasEl.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = background || getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#111111'; c.fillRect(0, 0, box.width, box.height);
    const content = elements.slice(0, 100); if (!content.length) return;
    const b = sceneBounds(content), scale = Math.max(.08, Math.min(.55, (box.width - 30) / (b.w + 20), (box.height - 24) / (b.h + 20)));
    c.save(); c.translate((box.width - b.w * scale) / 2 - b.x * scale, (box.height - b.h * scale) / 2 - b.y * scale); c.scale(scale, scale);
    drawElements(c, content, { background: null, preview: true, transparentEraser: false }); c.restore();
  }
  function renderDashboard() {
    const q = $('note-search').value.trim().toLowerCase();
    const grid = $('note-grid'); grid.innerHTML = '';
    const filtered = app.notes.filter(note => (note.title || '').toLowerCase().includes(q) || (note.elements || []).some(e => (e.text || e.label || '').toLowerCase().includes(q)));
    $('note-count').textContent = String(app.notes.length);
    $('empty-state').classList.toggle('show', filtered.length === 0);
    if (filtered.length === 0) {
      $('empty-state').querySelector('h3').textContent = q ? 'No canvases match that search.' : app.notes.length ? 'No results this time.' : 'Your first blank page is waiting.';
      $('empty-state').querySelector('p').textContent = q ? 'Try a different word or clear your search.' : 'Make a sketch, map out an idea, or drop in a screenshot to get started.';
    }
    for (const note of filtered) {
      const card = document.createElement('article'); card.className = 'note-card';
      const open = document.createElement('button'); open.className = 'note-preview'; open.type = 'button'; open.setAttribute('aria-label', `Open ${note.title}`);
      const preview = document.createElement('canvas'); open.appendChild(preview); const openLabel = document.createElement('span'); openLabel.className = 'preview-label'; openLabel.textContent = 'Open canvas ↗'; open.appendChild(openLabel);
      open.addEventListener('click', () => openNote(note));
      const content = document.createElement('div'); content.className = 'note-card-content';
      const titleRow = document.createElement('div'); titleRow.className = 'note-title-row';
      const title = document.createElement('button'); title.className = 'note-title'; title.textContent = note.title || 'Untitled canvas'; title.title = title.textContent; title.addEventListener('click', () => openNote(note));
      titleRow.appendChild(title); content.appendChild(titleRow);
      const sub = document.createElement('div'); sub.className = 'note-subtitle'; sub.textContent = `${new Date(note.updatedAt || note.createdAt || now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${(note.elements || []).length} objects`;
      content.appendChild(sub);
      const actions = document.createElement('div'); actions.className = 'note-card-actions';
      const addAction = (text, fn, cls = '') => { const b = document.createElement('button'); b.textContent = text; b.className = cls; b.addEventListener('click', fn); actions.appendChild(b); };
      addAction('Rename', () => renameNote(note)); addAction('Duplicate', () => duplicateNote(note)); addAction('Share', () => shareNoteFile(note)); addAction('Export', () => downloadProject(note)); addAction('Delete', () => deleteNote(note), 'delete-note');
      content.appendChild(actions); card.append(open, content); grid.appendChild(card);
      requestAnimationFrame(() => miniPreview(preview, note.elements || [], canvasBackgroundForNote(note)));
    }
  }

  function elementById(id) { return app.elements.find(e => e.id === id); }
  function isPathElement(e) { return !!e && ['arrow', 'line', 'connector'].includes(e.type); }
  function pathEndpoints(e) {
    return { start: { x: e.x, y: e.y }, end: { x: e.x + (e.w || 0), y: e.y + (e.h || 0) } };
  }
  // The draggable bend handle is an on-curve midpoint, not an invisible Bezier control point.
  // A quadratic curve's t=.5 point is (P0 + 2C + P1) / 4, so derive C from the visible handle.
  function pathBendPoint(e) {
    if (!isPathElement(e)) return { x: 0, y: 0 };
    if (e.bendPoint && Number.isFinite(e.bendPoint.x) && Number.isFinite(e.bendPoint.y)) return { x: e.bendPoint.x, y: e.bendPoint.y };
    const { start, end } = pathEndpoints(e), mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
    if (e.pathStyle === 'curved') {
      const bend = Math.max(16, Math.min(70, Math.hypot(end.x - start.x, end.y - start.y) * .22));
      const control = { x: mx + (end.y >= start.y ? bend : -bend), y: my - Math.sign(end.x - start.x || 1) * bend };
      return { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 };
    }
    return { x: mx, y: my };
  }
  function pathQuadraticControl(e) {
    const { start, end } = pathEndpoints(e), mid = pathBendPoint(e);
    return { x: 2 * mid.x - (start.x + end.x) / 2, y: 2 * mid.y - (start.y + end.y) / 2 };
  }
  function pathHandleAt(point, element) {
    if (!isPathElement(element)) return null;
    const { start, end } = pathEndpoints(element), bend = pathBendPoint(element), tolerance = 10 / app.zoom;
    const distance = q => Math.hypot(point.x - q.x, point.y - q.y);
    // Check the middle point first, as it is the primary control for bending the path.
    if (distance(bend) <= tolerance) return 'bend';
    if (distance(start) <= tolerance) return 'start';
    if (distance(end) <= tolerance) return 'end';
    return null;
  }
  const elementBoundsCache = new WeakMap();
  function boundsOf(e) {
    if (!e) return { x: 0, y: 0, w: 0, h: 0 };
    const cached = elementBoundsCache.get(e);
    if (cached && cached.x === e.x && cached.y === e.y && cached.w === e.w && cached.h === e.h && cached.type === e.type && cached.fontSize === e.fontSize && cached.points === e.points && cached.pathStyle === e.pathStyle && cached.bendPoint === e.bendPoint) return cached.bounds;
    let result;
    if ((e.type === 'stroke' || e.type === 'eraser') && e.points && e.points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of e.points) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
      result = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    } else {
      const width = e.w || (e.type === 'text' ? 220 : 1), height = e.h || (e.type === 'text' ? (e.fontSize || 21) * 1.5 : 1);
      const x2 = e.x + width, y2 = e.y + height;
      result = { x: Math.min(e.x, x2), y: Math.min(e.y, y2), w: Math.abs(x2 - e.x), h: Math.abs(y2 - e.y) };
      if (e.type === 'text') { result.y -= e.fontSize || 21; result.h += e.fontSize || 21; }
      if (isPathElement(e)) {
        const { start, end } = pathEndpoints(e), bend = pathBendPoint(e), control = pathQuadraticControl(e);
        const xs = [start.x, end.x, bend.x], ys = [start.y, end.y, bend.y];
        if (e.pathStyle === 'curved' || e.bendPoint) { xs.push(control.x); ys.push(control.y); }
        result = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
      }
    }
    elementBoundsCache.set(e, { x: e.x, y: e.y, w: e.w, h: e.h, type: e.type, fontSize: e.fontSize, points: e.points, pathStyle: e.pathStyle, bendPoint: e.bendPoint, bounds: result });
    return result;
  }
  function sceneBounds(elements) {
    const shown = elements.filter(e => !e.hidden && e.type !== 'eraser');
    if (!shown.length) return { x: 0, y: 0, w: 900, h: 620 };
    const bounds = shown.map(boundsOf); const minX = Math.min(...bounds.map(b => b.x)), minY = Math.min(...bounds.map(b => b.y));
    const maxX = Math.max(...bounds.map(b => b.x + b.w)), maxY = Math.max(...bounds.map(b => b.y + b.h));
    return { x: minX, y: minY, w: Math.max(100, maxX - minX), h: Math.max(80, maxY - minY) };
  }
  function drawElements(context, elements, opts = {}) {
    // Paint frames behind the rest without allocating multiple temporary arrays each frame.
    for (let i = 0; i < elements.length; i++) { const e = elements[i]; if (e.type === 'frame' && !e.hidden) paintElement(context, e, opts); }
    for (let i = 0; i < elements.length; i++) { const e = elements[i]; if (e.type !== 'frame' && !e.hidden) paintElement(context, e, opts); }
  }
  function fontFamilyCss(name, type = 'text') {
    const families = {
      Excalifont: '"Excalifont", "Comic Sans MS", cursive',
      Virgil: '"Virgil", "Excalifont", "Comic Sans MS", cursive',
      'Comic Shanns': '"Comic Shanns", "Comic Sans MS", monospace',
      Cascadia: '"Cascadia Code", "Cascadia", ui-monospace, SFMono-Regular, Consolas',
      'Cascadia Code': '"Cascadia Code", "Cascadia", ui-monospace, SFMono-Regular, Consolas',
      Nunito: '"Nunito", Arial',
      'Lilita One': '"Lilita One", system-ui',
      Assistant: 'Assistant, Arial',
      'Liberation Sans': '"Liberation Sans", Arial',
      Helvetica: 'Helvetica, Arial',
      'Comic Sans MS': '"Comic Sans MS", cursive',
      'Segoe Print': '"Segoe Print", "Comic Sans MS", cursive',
      'Bradley Hand': '"Bradley Hand", "Comic Sans MS", cursive',
      Chalkboard: 'Chalkboard, "Comic Sans MS", cursive',
      'Comic Neue': '"Comic Neue", "Comic Sans MS", cursive',
      'Trebuchet MS': '"Trebuchet MS", Arial',
      'Courier New': '"Courier New", monospace',
      Arial: 'Arial', Georgia: 'Georgia', Verdana: 'Verdana',
      'system-ui': 'system-ui'
    };
    let base = families[name] || (type === 'code' ? '"Cascadia Code", ui-monospace, SFMono-Regular, Consolas' : 'Arial');
    // Put color-emoji fonts before generic families (cursive/monospace/sans-serif),
    // and preserve the selected handwriting font in the live textarea as well as canvas.
    base = base.replace(/,\s*(cursive|sans-serif|monospace|serif|system-ui)$/i, '');
    return `${base}, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", ${type === 'code' ? 'monospace' : 'sans-serif'}`;
  }
  function paintElement(c, e, opts = {}) {
    if (e.hidden) return;
    const defaultInk = e.type === 'eraser' ? (opts.background || (app.theme === 'dark' ? '#1a1722' : '#fdfcff')) : (e.color || '#d4d4d4');
    c.save(); c.lineWidth = e.size || 3; c.strokeStyle = defaultInk; c.fillStyle = e.fill && e.fill !== 'none' ? e.fill : 'transparent'; c.lineCap = 'round'; c.lineJoin = 'round';
    if (e.opacity != null) c.globalAlpha = e.opacity;
    if (e.type === 'stroke' || e.type === 'eraser') {
      if (!e.points || !e.points.length) { c.restore(); return; }
      c.beginPath(); c.moveTo(e.points[0].x, e.points[0].y);
      if (e.points.length === 2) c.lineTo(e.points[1].x, e.points[1].y);
      else if (e.points.length > 2) { for (let i = 1; i < e.points.length - 1; i++) { const current = e.points[i], next = e.points[i + 1]; const mx = (current.x + next.x) / 2, my = (current.y + next.y) / 2; c.quadraticCurveTo(current.x, current.y, mx, my); } const last = e.points[e.points.length - 1]; c.lineTo(last.x, last.y); }
      c.lineWidth = (e.size || 3) * (e.type === 'eraser' ? 3.5 : 1); c.stroke();
    } else if (e.type === 'rect' || e.type === 'image' || e.type === 'code' || e.type === 'sticky' || e.type === 'frame') {
      const x = Math.min(e.x, e.x + (e.w || 0)), y = Math.min(e.y, e.y + (e.h || 0)), w = Math.abs(e.w || 1), h = Math.abs(e.h || 1);
      if (e.type === 'image') {
        const im = getImage(e.src);
        if (im && im.complete && im.naturalWidth) { c.drawImage(im, x, y, Math.max(1, w), Math.max(1, h)); }
        else { c.fillStyle = opts.preview ? '#d4d4d4' : (app.theme === 'dark' ? '#292433' : '#ebe6f2'); c.fillRect(x, y, w, h); c.strokeStyle = opts.preview ? '#569cd6' : '#857b95'; c.strokeRect(x, y, w, h); c.fillStyle = opts.preview ? '#569cd6' : '#857b95'; c.font = '12px sans-serif'; c.fillText('Image', x + 10, y + 22); }
      } else if (e.type === 'code') {
        c.fillStyle = e.fill || '#1f1f1f'; c.strokeStyle = e.color || '#454545'; c.beginPath(); c.roundRect(x, y, w, h, 8); c.fill(); c.stroke();
        c.fillStyle = '#569cd6'; c.font = '10px monospace'; c.fillText((e.language || 'code').toUpperCase(), x + 11, y + 17);
        c.fillStyle = e.textColor || '#e6e6e6'; c.font = `${e.fontStyle === 'italic' ? 'italic ' : ''}${e.fontWeight === 'bold' ? 'bold ' : ''}${e.fontSize || 12}px ${fontFamilyCss(e.fontFamily, 'code')}`; wrapText(c, e.text || '', x + 11, y + 35, Math.max(40, w - 22), (e.fontSize || 12) * 1.45, 14);
      } else if (e.type === 'sticky') {
        c.fillStyle = e.fill || '#fef3c7'; c.strokeStyle = e.color || '#c9a54a'; c.lineWidth = e.size || 1; c.beginPath(); c.roundRect(x, y, w, h, 4); c.fill(); c.stroke();
        c.fillStyle = e.textColor || '#55451f'; c.font = `${e.fontStyle === 'italic' ? 'italic ' : ''}${e.fontWeight === 'bold' ? 'bold ' : ''}${e.fontSize || 15}px ${fontFamilyCss(e.fontFamily)}`; wrapText(c, e.text || '', x + 12, y + 23, Math.max(40, w - 22), (e.fontSize || 15) * 1.4, 12);
      } else if (e.type === 'frame') {
        c.setLineDash([7, 4]); c.strokeStyle = e.color || (app.theme === 'dark' ? '#484848' : '#aaa0bb'); c.lineWidth = 1.5; c.strokeRect(x, y, w, h); c.setLineDash([]);
        c.fillStyle = opts.background || (app.theme === 'dark' ? '#1a1722' : '#fdfcff');
        const labelFontSize = e.fontSize || 11; c.font = `${e.fontStyle === 'italic' ? 'italic ' : ''}${e.fontWeight === 'bold' ? 'bold ' : ''}${labelFontSize}px ${fontFamilyCss(e.fontFamily)}`;
        c.fillRect(x + 1, y - Math.max(23, labelFontSize + 12), Math.max(45, c.measureText(e.label || 'Frame').width + 15), Math.max(23, labelFontSize + 12));
        c.fillStyle = e.textColor || e.color || (app.theme === 'dark' ? '#b5cea8' : '#6c617e'); c.fillText(e.label || 'Frame', x + 6, y - 8);
      } else {
        if (e.fill && e.fill !== 'none') { c.fillStyle = e.fill; c.beginPath(); c.roundRect(x, y, w, h, Math.min(9, Math.max(3, Math.min(w, h) * 0.06))); c.fill(); }
        c.beginPath(); c.roundRect(x, y, w, h, Math.min(9, Math.max(3, Math.min(w, h) * 0.06))); c.stroke();
        if (e.type === 'rect' && e.text) drawShapeText(c, e, { x, y, w, h });
      }
    } else if (e.type === 'ellipse') {

      const x = e.x, y = e.y, w = e.w || 1, h = e.h || 1;
      c.beginPath(); c.ellipse(x + w / 2, y + h / 2, Math.max(0.5, Math.abs(w / 2)), Math.max(0.5, Math.abs(h / 2)), 0, 0, Math.PI * 2);
      if (e.fill && e.fill !== 'none') c.fill(); c.stroke();
      if (e.text) drawShapeText(c, e, { x, y, w, h });
    } else if (e.type === 'diamond') {
      const x = e.x, y = e.y, w = e.w || 1, h = e.h || 1;
      c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w, y + h / 2); c.lineTo(x + w / 2, y + h); c.lineTo(x, y + h / 2); c.closePath();
      if (e.fill && e.fill !== 'none') c.fill(); c.stroke();
      if (e.text) drawShapeText(c, e, { x, y, w, h });
    } else if (e.type === 'arrow' || e.type === 'line' || e.type === 'connector') {
      const x1 = e.x, y1 = e.y, x2 = e.x + e.w, y2 = e.y + e.h;
      const route = e.pathStyle || 'straight';
      const mx = (x1 + x2) / 2;
      const control = pathQuadraticControl(e);
      c.beginPath(); c.moveTo(x1, y1);
      if (route === 'elbow' && !e.bendPoint) { c.lineTo(mx, y1); c.lineTo(mx, y2); c.lineTo(x2, y2); }
      else if (route === 'curved' || e.bendPoint) c.quadraticCurveTo(control.x, control.y, x2, y2);
      else c.lineTo(x2, y2);
      c.stroke();
      if (e.type === 'arrow' || e.type === 'connector') {
        const a = route === 'elbow' && !e.bendPoint ? (Math.abs(x2 - mx) > 0.5 ? (x2 >= mx ? 0 : Math.PI) : (y2 >= y1 ? Math.PI / 2 : -Math.PI / 2)) : (route === 'curved' || e.bendPoint) ? Math.atan2(y2 - control.y, x2 - control.x) : Math.atan2(y2 - y1, x2 - x1), n = 10 + (e.size || 3);
        c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - n * Math.cos(a - Math.PI / 6), y2 - n * Math.sin(a - Math.PI / 6)); c.moveTo(x2, y2); c.lineTo(x2 - n * Math.cos(a + Math.PI / 6), y2 - n * Math.sin(a + Math.PI / 6)); c.stroke();
      }
      if (e.label) { const labelFontSize = e.fontSize || 12; c.font = `${e.fontStyle === 'italic' ? 'italic ' : ''}${e.fontWeight === 'bold' ? 'bold ' : ''}${labelFontSize}px ${fontFamilyCss(e.fontFamily)}`; c.fillStyle = e.textColor || e.color || defaultInk; c.fillText(e.label, (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 6); }
    } else if (e.type === 'text') {
      c.fillStyle = e.color || defaultInk; c.font = `${e.fontStyle === 'italic' ? 'italic ' : ''}${e.fontWeight === 'bold' ? 'bold ' : ''}${e.fontSize || 21}px ${fontFamilyCss(e.fontFamily)}`; c.textBaseline = 'alphabetic';
      const fs = e.fontSize || 21, lineHeight = fs * 1.3, maxWidth = Math.max(50, e.w || 260); let lineY = e.y;
      (e.text || '').split('\n').forEach(explicitLine => {
        const before = []; let line = '';
        for (const word of explicitLine.split(/\s+/)) { const test = line ? `${line} ${word}` : word; if (line && c.measureText(test).width > maxWidth) { before.push(line); line = word; } else line = test; }
        before.push(line); before.forEach(str => { c.fillText(str, e.x, lineY); lineY += lineHeight; });
      });
    }
    if (opts.preview && e.type === 'frame') { /* frames are useful in the full editor, not the thumbnail focus */ }
    c.restore();
  }
  function drawShapeText(c, e, b) {
    const text = String(e.text || ''); if (!text) return;
    const fs = e.fontSize || 20, lineHeight = fs * 1.3;
    c.save(); c.fillStyle = e.textColor || (app.theme === 'dark' ? '#e6e6e6' : '#d4d4d4');
    c.font = `${e.fontStyle === 'italic' ? 'italic ' : ''}${e.fontWeight === 'bold' ? 'bold ' : ''}${fs}px ${fontFamilyCss(e.fontFamily)}`;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    const lines = text.split('\n'); const approxLines = Math.min(12, Math.max(lines.length, Math.floor((b.h - 12) / lineHeight)));
    const firstY = b.y + Math.max(fs + 4, (b.h - approxLines * lineHeight) / 2 + fs);
    wrapText(c, text, b.x + b.w / 2, firstY, Math.max(30, b.w - 20), lineHeight, Math.min(12, Math.max(1, Math.floor((b.h - 8) / lineHeight))));
    c.restore();
  }
  function wrapText(c, text, x, y, maxWidth, lineHeight, maxLines = 100) {
    const words = String(text).split(/\s+/); let line = '', lines = [];
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test;
      if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    lines.slice(0, maxLines).forEach((str, i) => c.fillText(str, x, y + i * lineHeight));
  }
  const imageCache = new Map();
  function getImage(src) {
    if (!src || !/^data:image\//i.test(src)) return null;
    if (imageCache.has(src)) return imageCache.get(src);
    const image = new Image(); image.onload = () => { if (app.view === 'editor') redraw(); }; image.src = src; imageCache.set(src, image); return image;
  }
  function resizeCanvas() {
    const rect = viewport.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1); const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    redraw();
  }
  let redrawQueued = false;
  function queueRedraw() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => { redrawQueued = false; redraw(); });
  }
  function redraw() {
    if (app.view !== 'editor' || !canvas || !ctx) return;
    const rect = viewport.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = app.canvasBackground || defaultCanvasBackground(); ctx.fillStyle = bg; ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.save(); ctx.setTransform(dpr * app.zoom, 0, 0, dpr * app.zoom, dpr * app.panX, dpr * app.panY);
    if (app.grid) {
      const step = 24; const left = -app.panX / app.zoom, top = -app.panY / app.zoom;
      const startX = Math.floor(left / step) * step, startY = Math.floor(top / step) * step;
      ctx.fillStyle = app.theme === 'dark' ? '#2a2a2a' : '#e5dfed';
      ctx.beginPath();
      for (let x = startX; x < left + rect.width / app.zoom + step; x += step) {
        for (let y = startY; y < top + rect.height / app.zoom + step; y += step) ctx.moveTo(x + 0.75, y), ctx.arc(x, y, 0.75, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    // While editing, render the textarea as the single source of visible text.
    // Hide the matching canvas text by element type (not editor subtype): this
    // prevents the original glyphs and the live textarea from appearing doubled
    // if an editor was opened through a shape/label path or older saved metadata.
    let visibleElements = app.elements;
    const activeEdit = app.inlineText?.editId ? app.inlineText : null;
    if (activeEdit) {
      const editedElement = elementById(activeEdit.editId);
      if (editedElement?.type === 'text') {
        visibleElements = app.elements.filter(e => e.id !== activeEdit.editId);
      } else {
        visibleElements = app.elements.map(e => {
          if (e.id !== activeEdit.editId) return e;
          if (['shape-label', 'frame-label'].includes(activeEdit.type)) return { ...e, label: '' };
          if (activeEdit.type === 'shape-text' || (['sticky', 'code'].includes(e.type) && activeEdit.type === e.type)) return { ...e, text: '' };
          return e;
        });
      }
    }
    drawElements(ctx, visibleElements, { background: bg });
    if (app.preview) paintElement(ctx, app.preview, { background: bg });
    // Do not draw a selection box over the inline editor; it can look like a
    // second text layer and makes caret placement harder to judge.
    for (const id of app.selectedIds) if (id !== activeEdit?.editId) drawSelection(ctx, elementById(id));
    if (app.drag?.mode === 'marquee' && app.drag.current) {
      const x = Math.min(app.drag.start.x, app.drag.current.x), y = Math.min(app.drag.start.y, app.drag.current.y), w = Math.abs(app.drag.current.x - app.drag.start.x), h = Math.abs(app.drag.current.y - app.drag.start.y);
      ctx.save(); ctx.fillStyle = '#569cd618'; ctx.strokeStyle = '#569cd6'; ctx.lineWidth = 1 / app.zoom; ctx.setLineDash([4 / app.zoom, 3 / app.zoom]); ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.restore();
    }
    ctx.restore();
    $('zoom-value').textContent = `${Math.round(app.zoom * 100)}%`;
    $('canvas-viewport').dataset.tool = app.spaceHeld ? 'hand' : app.tool;
    $('element-count').textContent = `${app.elements.length} object${app.elements.length === 1 ? '' : 's'}`;
    updateInlineTextPosition(); updateSelectionToolbar(); updateTextFormatToolbar();
  }
  function drawSelection(c, e) {
    if (!e || e.hidden) return;
    const b = boundsOf(e); c.save(); c.strokeStyle = '#569cd6'; c.lineWidth = 1.3 / app.zoom; c.setLineDash([5 / app.zoom, 4 / app.zoom]); c.strokeRect(b.x - 5 / app.zoom, b.y - 5 / app.zoom, b.w + 10 / app.zoom, b.h + 10 / app.zoom); c.setLineDash([]);
    c.fillStyle = '#fff'; c.strokeStyle = '#569cd6'; c.lineWidth = 1.4 / app.zoom;
    if (isPathElement(e)) {
      const { start, end } = pathEndpoints(e), bend = pathBendPoint(e), r = 4.2 / app.zoom;
      // The visible middle handle sits ON the rendered curve; drag it to bend the line.
      for (const point of [start, end]) { c.beginPath(); c.arc(point.x, point.y, r, 0, Math.PI * 2); c.fill(); c.stroke(); }
      c.fillStyle = '#dbeafe'; c.beginPath(); c.arc(bend.x, bend.y, 5.6 / app.zoom, 0, Math.PI * 2); c.fill(); c.stroke();
    } else {
      const r = 5 / app.zoom; c.beginPath(); c.arc(b.x + b.w, b.y + b.h, r, 0, Math.PI * 2); c.fill(); c.stroke();
    }
    c.restore();
  }
  function screenToWorld(ev) {
    const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - app.panX) / app.zoom, y: (ev.clientY - r.top - app.panY) / app.zoom };
  }
  function hitTest(point) {
    for (let i = app.elements.length - 1; i >= 0; i--) {
      const e = app.elements[i]; if (e.hidden || e.locked) continue;
      const b = boundsOf(e), pad = 7 / app.zoom;
      const inside = point.x >= b.x - pad && point.x <= b.x + b.w + pad && point.y >= b.y - pad && point.y <= b.y + b.h + pad;
      if (e.type === 'frame') {
        const nearEdge = Math.abs(point.x - b.x) <= pad || Math.abs(point.x - (b.x + b.w)) <= pad || Math.abs(point.y - b.y) <= pad || Math.abs(point.y - (b.y + b.h)) <= pad;
        const onTitle = point.x >= b.x - pad && point.x <= b.x + Math.max(60, b.w) && point.y >= b.y - 27 / app.zoom && point.y <= b.y + 2 / app.zoom;
        if (nearEdge || onTitle) return e;
        continue;
      }
      const labelHit = ['arrow', 'line', 'connector'].includes(e.type) && e.label &&
        point.x >= (e.x + (e.w || 0) / 2 - Math.max(32, String(e.label).length * (e.fontSize || 12) * 0.32)) &&
        point.x <= (e.x + (e.w || 0) / 2 + Math.max(32, String(e.label).length * (e.fontSize || 12) * 0.32)) &&
        point.y >= (e.y + (e.h || 0) / 2 - (e.fontSize || 12) - 8) &&
        point.y <= (e.y + (e.h || 0) / 2 + 6);
      if (inside || labelHit) return e;
    }
    return null;
  }
  function handleHit(point, element) {
    if (!element || element.locked || isPathElement(element)) return false;
    const b = boundsOf(element), pad = 9 / app.zoom;
    return Math.abs(point.x - (b.x + b.w)) <= pad && Math.abs(point.y - (b.y + b.h)) <= pad;
  }
  function updateCanvasCursor(ev) {
    if (ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) {
      app.lastPointer = { clientX: ev.clientX, clientY: ev.clientY };
    }
    if (app.view !== 'editor' || !canvas || !viewport) return;
    let cursor = 'default';
    if (app.inlineText) cursor = 'text';
    else if (app.drag?.mode === 'resize') cursor = 'nwse-resize';
    else if (app.drag?.mode === 'bend' || app.drag?.mode === 'path-start' || app.drag?.mode === 'path-end' || app.drag?.mode === 'move' || app.drag?.mode === 'pan') cursor = 'grabbing';
    else if (app.spaceHeld || app.tool === 'hand') cursor = 'grab';
    else if (app.tool === 'select') {
      if (app.lastPointer) {
        const rect = canvas.getBoundingClientRect();
        const withinCanvas = app.lastPointer.clientX >= rect.left && app.lastPointer.clientX <= rect.right &&
          app.lastPointer.clientY >= rect.top && app.lastPointer.clientY <= rect.bottom;
        if (withinCanvas) {
          const point = screenToWorld(app.lastPointer);
          const hovered = hitTest(point);
          const selected = elementById(app.selectedId);
          const pathHandle = selected && hovered?.id === selected.id ? pathHandleAt(point, selected) : null;
          if (pathHandle === 'bend') cursor = 'grab';
          else if (pathHandle === 'start' || pathHandle === 'end') cursor = 'crosshair';
          else if (selected && hovered?.id === selected.id && handleHit(point, selected)) cursor = 'nwse-resize';
          else if (hovered) cursor = 'move';
        }
      }
    } else {
      const cursors = { pen: 'crosshair', eraser: 'url(/assets/eraser-cursor.svg) 10 10, crosshair', rect: 'crosshair', ellipse: 'crosshair', diamond: 'crosshair', arrow: 'crosshair', line: 'crosshair', sticky: 'crosshair', frame: 'crosshair', text: 'text', image: 'copy' };
      cursor = cursors[app.tool] || 'default';
    }
    canvas.style.cursor = cursor;
    viewport.style.cursor = cursor;
    viewport.dataset.tool = app.spaceHeld ? 'hand' : app.tool;
  }
  function translateElement(e, dx, dy) {
    const moved = { ...e, x: (e.x || 0) + dx, y: (e.y || 0) + dy };
    if (e.points) moved.points = e.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
    if (e.bendPoint) moved.bendPoint = { x: e.bendPoint.x + dx, y: e.bendPoint.y + dy };
    return moved;
  }
  function resizeElement(e, dx, dy, base) {
    if (e.type === 'stroke' || e.type === 'eraser') {
      const b = boundsOf(base), nextW = Math.max(12, b.w + dx), nextH = Math.max(12, b.h + dy), sx = nextW / b.w, sy = nextH / b.h;
      return { ...base, points: (base.points || []).map(p => ({ ...p, x: b.x + (p.x - b.x) * sx, y: b.y + (p.y - b.y) * sy })) };
    }
    const b = boundsOf(base), width = Math.max(12, b.w + dx), height = Math.max(12, b.h + dy);
    if (isPathElement(e)) {
      const sx = width / Math.max(1, b.w), sy = height / Math.max(1, b.h);
      const transform = point => ({ x: b.x + (point.x - b.x) * sx, y: b.y + (point.y - b.y) * sy });
      const start = transform({ x: base.x, y: base.y }), end = transform({ x: base.x + base.w, y: base.y + base.h });
      const next = { ...base, x: start.x, y: start.y, w: end.x - start.x, h: end.y - start.y };
      if (base.bendPoint) next.bendPoint = transform(base.bendPoint);
      return next;
    }
    if (e.type === 'text') { const fs = e.fontSize || 21; return { ...base, x: b.x, y: b.y + fs, w: width, h: Math.max(10, height - fs) }; }
    return { ...base, x: b.x, y: b.y, w: width, h: height };
  }
  function setTool(tool) {
    app.tool = tool;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    // Tools in the overflow palette still show an active state while the palette is closed.
    $('tools-more-button')?.classList.toggle('active', ['sticky', 'frame'].includes(tool));
    const hints = { select: 'Select and move · double-click empty canvas to type · Delete removes selection', hand: 'Pan canvas · drag to move around', pen: 'Write or sketch with your mouse, finger or stylus', eraser: 'Erase marks by drawing over them', rect: 'Click and drag to draw a rectangle', ellipse: 'Click and drag to draw an ellipse', diamond: 'Click and drag to draw a decision diamond', arrow: 'Click and drag to draw an arrow', line: 'Click and drag to draw a line', text: 'Click anywhere on the canvas and type directly · Enter adds a line · Ctrl+Enter finishes', sticky: 'Click and drag to place a sticky note', image: 'Choose an image or drop one directly onto the canvas' };
    $('tool-hint').textContent = hints[tool] || 'Draw freely'; $('canvas-viewport').dataset.tool = tool;
    updateCanvasCursor();
  }
  function startInlineText(data) {
    if (app.inlineText) finishInlineText(false);
    const existing = data.editId ? elementById(data.editId) : null;
    const type = data.inlineType || existing?.type || data.type || 'text';
    const baseFontSize = type === 'code' ? 13 : type === 'sticky' ? 15 : 22;
    const fontSize = Math.max(8, Math.min(96, Number(data.fontSize || existing?.fontSize) || baseFontSize));
    app.inlineText = {
      x: Number(data.x ?? existing?.x) || 0, y: Number(data.y ?? existing?.y) || 0,
      editId: existing?.id || null, type, fontSize,
      color: data.textColor || (type === 'code' ? '#e6e6e6' : type === 'sticky' ? '#55451f' : (data.color || existing?.textColor || existing?.color || (app.theme === 'dark' ? '#e6e6e6' : app.color))),
      size: existing?.size || app.size, w: Math.max(80, Number(data.w ?? existing?.w) || (type === 'text' ? 260 : 320)),
      h: Number(data.h ?? existing?.h) || (type === 'text' ? 80 : type === 'sticky' ? 125 : 160),
      fontFamily: existing?.fontFamily || data.fontFamily || (type === 'code' ? 'Cascadia Code' : 'Excalifont'),
      fontWeight: existing?.fontWeight || data.fontWeight || 'normal',
      fontStyle: existing?.fontStyle || data.fontStyle || 'normal',
      language: existing?.language || data.language || 'javascript',
      originalText: existing?.text || ''
    };
    const editor = $('canvas-text-editor');
    editor.value = existing?.text ?? data.text ?? '';
    editor.classList.remove('hidden');
    $('selection-toolbar').classList.add('hidden');
    $('selection-more-menu').classList.add('hidden');
    setTool('text');
    updateInlineTextPosition();
    updateTextFormatToolbar();
    // Immediately repaint before focus so the original canvas text is hidden
    // before the transparent textarea appears. Without this redraw, the old
    // canvas glyphs remain visible beneath the live editor until a later event.
    redraw();
    requestAnimationFrame(() => { editor.focus({ preventScroll: true }); editor.setSelectionRange(editor.value.length, editor.value.length); resizeInlineTextArea(); });
  }
  function updateInlineTextPosition() {
    const editor = $('canvas-text-editor');
    if (!editor || !app.inlineText) return;
    const s = app.inlineText;
    const isText = ['text', 'shape-text', 'shape-label', 'frame-label'].includes(s.type);
    const insetX = ['shape-text', 'shape-label', 'frame-label'].includes(s.type) ? 0 : isText ? 0 : 12;
    const insetY = isText ? -s.fontSize * 0.92 : (s.type === 'code' ? 27 : 10);
    editor.style.left = `${(s.x + insetX) * app.zoom + app.panX}px`;
    // Canvas text uses a baseline at s.y. A textarea uses a line-box top,
    // so align its first glyph baseline with the canvas baseline to avoid a
    // ghost/doubled look when the same element is being edited.
    const alignedInsetY = isText ? -s.fontSize * 0.95 : insetY;
    editor.style.top = `${(s.y + alignedInsetY) * app.zoom + app.panY}px`;
    editor.style.width = `${Math.max(80, (s.w - insetX * 2) * app.zoom)}px`;
    editor.style.fontSize = `${s.fontSize * app.zoom}px`;
    editor.style.lineHeight = '1.3';
    editor.style.color = s.color || (app.theme === 'dark' ? '#e6e6e6' : '#d4d4d4');
    editor.style.textAlign = ['shape-text', 'shape-label'].includes(s.type) ? 'center' : 'left';
    editor.style.fontFamily = s.type === 'code' ? 'ui-monospace, SFMono-Regular, Consolas, monospace' : fontFamilyCss(s.fontFamily, s.type);
    editor.style.fontWeight = s.fontWeight || 'normal';
    editor.style.fontStyle = s.fontStyle || 'normal';
    editor.style.minHeight = ['text', 'shape-text', 'shape-label', 'frame-label'].includes(s.type) ? `${Math.max(1.4, (s.h || 42) / (['shape-text', 'shape-label', 'frame-label'].includes(s.type) ? 1 : Math.max(1, s.fontSize)) * (['shape-text', 'shape-label', 'frame-label'].includes(s.type) ? app.zoom : s.fontSize * app.zoom))}px` : `${Math.max(42, (s.h - (s.type === 'code' ? 42 : 20)) * app.zoom)}px`;
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(s.fontSize * app.zoom * 1.4, editor.scrollHeight, ['text', 'shape-text'].includes(s.type) ? 0 : (s.h - (s.type === 'code' ? 42 : 20)) * app.zoom)}px`;
    editor.style.background = 'transparent';
    editor.style.padding = '0';
    editor.style.borderRadius = '4px';
    editor.style.whiteSpace = 'pre-wrap';
    editor.style.overflowWrap = 'break-word';
    editor.style.wordBreak = 'normal';
    editor.style.wordSpacing = 'normal';
    editor.style.letterSpacing = '0px';
    editor.style.textRendering = 'geometricPrecision';
    editor.style.overflow = s.type === 'text' ? 'hidden' : 'auto';
  }
  function resizeInlineTextArea() {
    const editor = $('canvas-text-editor');
    if (!app.inlineText || !editor) return;
    editor.style.height = 'auto';
    const minHeight = ['text', 'shape-text', 'shape-label', 'frame-label'].includes(app.inlineText.type) ? app.inlineText.fontSize * app.zoom * 1.4 : (app.inlineText.h - (app.inlineText.type === 'code' ? 42 : 20)) * app.zoom;
    editor.style.height = `${Math.max(minHeight, editor.scrollHeight)}px`;
    updateTextFormatToolbar();
  }
  function finishInlineText(cancel = false) {
    if (!app.inlineText) return;
    if (typeof app.emojiPickerCleanup === 'function') app.emojiPickerCleanup();
    const state = app.inlineText, editor = $('canvas-text-editor');
    const value = editor.value, measuredHeight = Math.max(state.fontSize * 1.4, editor.scrollHeight / Math.max(.2, app.zoom));
    editor.classList.add('hidden');
    app.inlineText = null;
    if (!cancel) {
      const existing = state.editId ? elementById(state.editId) : null;
      if (!value.trim()) {
        if (existing && state.type === 'shape-text') { snapshotHistory(); existing.text = ''; delete existing.textColor; chooseSelected(existing.id); scheduleSave(); broadcastScene(); updateCounts(); }
        else if (existing && ['shape-label', 'frame-label'].includes(state.type)) { snapshotHistory(); existing.label = ''; chooseSelected(existing.id); scheduleSave(); broadcastScene(); updateCounts(); }
        else if (existing && ['code', 'sticky'].includes(existing.type)) { snapshotHistory(); existing.text = ''; existing.textColor = state.color; chooseSelected(existing.id); scheduleSave(); broadcastScene(); updateCounts(); }
        else if (existing) { snapshotHistory(); app.elements = app.elements.filter(e => e.id !== existing.id); chooseSelected(null); scheduleSave(); broadcastScene(); updateCounts(); }
      } else if (existing) {
        snapshotHistory(); if (['shape-label', 'frame-label'].includes(state.type)) existing.label = value; else existing.text = value; existing.fontSize = state.fontSize; existing.fontFamily = state.fontFamily; existing.fontWeight = state.fontWeight; existing.fontStyle = state.fontStyle;
        if (existing.type === 'code' || existing.type === 'sticky' || ['shape-text', 'shape-label', 'frame-label'].includes(state.type)) existing.textColor = state.color;
        else existing.color = state.color;
        if (existing.type === 'text') { existing.w = state.w; existing.h = measuredHeight; }
        if (existing.type === 'code') { existing.language = state.language || existing.language || 'javascript'; existing.label = `${existing.language} code`; existing.h = Math.min(560, Math.max(existing.h || 150, 48 + value.split(String.fromCharCode(10)).length * (state.fontSize * 1.45))); }
        if (existing.type === 'sticky') existing.h = Math.min(360, Math.max(existing.h || 125, measuredHeight + 25));
        chooseSelected(existing.id); scheduleSave(); broadcastScene(); updateCounts();
      } else {
        const el = { id: uid(), type: 'text', x: state.x, y: state.y, w: state.w, h: measuredHeight, text: value, color: state.color, size: state.size, fontSize: state.fontSize, fontFamily: state.fontFamily, fontWeight: state.fontWeight, fontStyle: state.fontStyle };
        snapshotHistory(); app.elements = [...app.elements, el]; app.selectedId = el.id; app.selectedIds = [el.id]; updateCounts(); renderLayerPanel(); scheduleSave(); broadcastScene(); chooseSelected(el.id);
      }
    } else if (state.editId) chooseSelected(state.editId); else redraw();
    setTool('select'); updateSelectionToolbar(); updateTextFormatToolbar();
  }
  function updateTextFormatToolbar() {
    const bar = $('text-format-toolbar');
    if (!bar) return;
    const selected = elementById(app.selectedId);
    const target = app.inlineText || (selected && ['text', 'code', 'sticky'].includes(selected.type) ? selected : null);
    if (app.view !== 'editor' || !target) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const type = target.type || 'text';
    const family = $('inline-font-family');
    family.value = [...family.options].some(o => o.value === (target.fontFamily || 'Excalifont')) ? (target.fontFamily || 'Excalifont') : 'Arial';
    $('font-size-input').value = String(target.fontSize || (type === 'code' ? 13 : type === 'sticky' ? 15 : 22));
    $('text-bold').classList.toggle('active', target.fontWeight === 'bold');
    $('text-italic').classList.toggle('active', target.fontStyle === 'italic');
    const textColor = target.textColor || (type === 'code' ? '#e6e6e6' : type === 'sticky' ? '#55451f' : target.color) || '#d4d4d4';
    $('text-color-picker').value = /^#[0-9a-f]{6}$/i.test(textColor) ? textColor : '#d4d4d4';
    $('inline-code-language').classList.toggle('hidden', type !== 'code');
    if (type === 'code') $('inline-code-language').value = [...$('inline-code-language').options].some(o => o.value === target.language) ? target.language : 'text';
    const b = type === 'text' ? { x: target.x, y: target.y - (target.fontSize || 22), w: target.w || 180, h: target.h || 45 } : boundsOf(target);
    const r = viewport.getBoundingClientRect(), width = bar.offsetWidth || 320;
    const left = Math.max(6, Math.min(r.width - width - 6, (b.x + b.w / 2) * app.zoom + app.panX - width / 2));
    const barHeight = bar.offsetHeight || 34;
    const above = b.y * app.zoom + app.panY - barHeight - 14;
    // Keep the formatter out of the text's first line; only fall below when no room exists above.
    const top = above > 8 ? above : Math.min(r.height - barHeight - 8, Math.max(48, (b.y + b.h) * app.zoom + app.panY + 10));
    bar.style.left = `${left}px`; bar.style.top = `${Math.max(8, top)}px`;
  }
  function applyTextFormat(key, value) {
    if (app.inlineText) {
      if (key === 'fontSize') app.inlineText.fontSize = Math.max(8, Math.min(96, Number(value) || 22));
      else app.inlineText[key] = value;
      updateInlineTextPosition(); resizeInlineTextArea(); updateTextFormatToolbar(); redraw();
      return;
    }
    const e = elementById(app.selectedId); if (!e || !['text', 'code', 'sticky'].includes(e.type)) return;
    snapshotHistory();
    if (key === 'fontSize') e.fontSize = Math.max(8, Math.min(96, Number(value) || 22));
    else if (key === 'color' && ['code', 'sticky'].includes(e.type)) e.textColor = value;
    else e[key] = value;
    redraw(); scheduleSave(); broadcastScene(); renderLayerPanel(); updateTextFormatToolbar();
  }
  function updateSelectionToolbar() {
    const bar = $('selection-toolbar');
    if (!bar) return;
    const ids = app.selectedIds.length ? app.selectedIds : (app.selectedId ? [app.selectedId] : []);
    const selected = ids.map(elementById).filter(e => e && !e.hidden);
    if (app.view !== 'editor' || app.inlineText || !selected.length) { bar.classList.add('hidden'); return; }
    const pathQuick = $('path-style-quick');
    const isSinglePath = selected.length === 1 && ['arrow', 'line', 'connector'].includes(selected[0].type);
    if (pathQuick) {
      pathQuick.classList.toggle('hidden', !isSinglePath);
      const style = isSinglePath ? (selected[0].pathStyle || 'straight') : 'straight';
      pathQuick.querySelectorAll('[data-path-style-quick]').forEach(button => {
        const active = button.dataset.pathStyleQuick === style;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
    }
    const bounds = selected.map(boundsOf);
    const x1 = Math.min(...bounds.map(b => b.x)), y1 = Math.min(...bounds.map(b => b.y));
    const x2 = Math.max(...bounds.map(b => b.x + b.w)), y2 = Math.max(...bounds.map(b => b.y + b.h));
    bar.classList.remove('hidden');
    const r = viewport.getBoundingClientRect(), w = bar.offsetWidth || 112, h = bar.offsetHeight || 42;
    const centerX = ((x1 + x2) / 2) * app.zoom + app.panX;
    const above = y1 * app.zoom + app.panY - h - 11;
    const y = above > 6 ? above : Math.min(r.height - h - 8, y2 * app.zoom + app.panY + 11);
    const x = Math.max(6, Math.min(r.width - w - 6, centerX - w / 2));
    bar.style.left = `${x}px`; bar.style.top = `${Math.max(6, y)}px`;
  }
  function toggleInspector() {
    const panel = $('inspector');
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !opening);
    $('editor-more-menu').classList.add('hidden');
    $('toggle-inspector').setAttribute('aria-pressed', String(opening));
    if (opening) setInspectorTab(app.selectedId ? 'properties' : 'layers');
    requestAnimationFrame(() => { resizeCanvas(); redraw(); });
  }
  function showShortcuts() {
    const rows = [
      ['V', 'Select and move'], ['H / Space', 'Pan canvas'], ['P', 'Pencil / handwriting'], ['E', 'Eraser'], ['R', 'Rectangle'], ['O', 'Ellipse'], ['D', 'Diamond'], ['A', 'Arrow'], ['L', 'Line'], ['T', 'Text; double-click empty canvas to type'], ['N', 'Sticky note'], ['I', 'Insert image'], ['F', 'Add frame'], ['K', 'Code block'], ['M', 'Mermaid flowchart'],
      ['Ctrl / ⌘ + Z', 'Undo'], ['Ctrl / ⌘ + Shift + Z', 'Redo'], ['Ctrl / ⌘ + D', 'Duplicate selected'], ['Delete / Backspace', 'Delete selected'], ['Ctrl / ⌘ + A', 'Select all'], ['Ctrl / ⌘ + S', 'Save now'], ['Arrow keys', 'Nudge selection'], ['Shift + Arrow', 'Nudge farther'], ['Ctrl / ⌘ + 0', 'Fit drawing'], ['Enter', 'New line while writing on canvas'], ['Ctrl / ⌘ + Enter', 'Finish canvas text'], ['Esc', 'Cancel text / deselect']
    ];
    const body = `<div class="shortcut-grid">${rows.map(([key,desc]) => `<div class="shortcut-row"><kbd>${escapeHTML(key)}</kbd><span>${escapeHTML(desc)}</span></div>`).join('')}</div><p class="modal-tip">On Mac, use ⌘ instead of Ctrl. Double-click an empty part of the board to type directly on the canvas. Press Enter for a new line, Ctrl/Cmd+Enter to finish, or Escape to cancel.</p>`;
    openModal({ title: 'Keyboard shortcuts', eyebrow: 'QUICK REFERENCE', subtitle: 'Keep your hands on the canvas and move faster.', wide: true, submitText: 'Got it', body });
  }
  function setInspectorTab(tab) {
    document.querySelectorAll('.inspector-tab').forEach(b => b.classList.toggle('active', b.dataset.inspector === tab));
    $('properties-panel').classList.toggle('hidden', tab !== 'properties'); $('layers-panel').classList.toggle('hidden', tab !== 'layers');
  }
  function updateCounts() { $('element-count').textContent = `${app.elements.length} object${app.elements.length === 1 ? '' : 's'}`; $('layer-count').textContent = String(app.elements.length); }
  function chooseSelected(id) {
    app.selectedId = id; app.selectedIds = id ? [id] : []; const e = elementById(id);
    $('selection-empty').classList.toggle('hidden', !!e); $('selection-controls').classList.toggle('hidden', !e);
    $('selection-type').textContent = e ? (e.label || e.type) : 'Nothing selected';
    if (e) {
      $('selected-color').value = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#d4d4d4';
      $('selected-fill').value = e.fill || 'none'; $('selected-size').value = e.size || 3; $('selected-label').value = e.label || ''; $('lock-object').checked = !!e.locked;
      const hasPathStyle = ['arrow','line','connector'].includes(e.type);
      $('selected-path-style').value = e.pathStyle || 'straight'; $('selected-path-style-row').classList.toggle('hidden', !hasPathStyle);
      const inspector = $('inspector'); inspector.classList.remove('hidden'); $('toggle-inspector').setAttribute('aria-pressed', 'true'); setInspectorTab('properties');
      $('object-path-style').value = e.pathStyle || 'straight'; $('path-style-row').classList.toggle('hidden', !hasPathStyle);
    } else { $('path-style-row').classList.add('hidden'); $('selected-path-style-row').classList.add('hidden'); }
    redraw(); renderLayerPanel();
  }
  function chooseSelectedKeepMany(id, ids) {
    app.selectedId = id; app.selectedIds = [...new Set(ids)]; const e = elementById(id);
    $('selection-empty').classList.toggle('hidden', !!e); $('selection-controls').classList.toggle('hidden', !e);
    $('selection-type').textContent = app.selectedIds.length > 1 ? `${app.selectedIds.length} objects selected` : (e ? (e.label || e.type) : 'Nothing selected');
    if (e) {
      $('selected-color').value = /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '#d4d4d4';
      $('selected-fill').value = e.fill || 'none'; $('selected-size').value = e.size || 3; $('selected-label').value = e.label || ''; $('lock-object').checked = !!e.locked;
      const hasPathStyle = ['arrow','line','connector'].includes(e.type);
      $('selected-path-style').value = e.pathStyle || 'straight'; $('selected-path-style-row').classList.toggle('hidden', !hasPathStyle);
      const inspector = $('inspector'); inspector.classList.remove('hidden'); $('toggle-inspector').setAttribute('aria-pressed', 'true'); setInspectorTab('properties');
      $('object-path-style').value = e.pathStyle || 'straight'; $('path-style-row').classList.toggle('hidden', !hasPathStyle);
    } else { $('path-style-row').classList.add('hidden'); $('selected-path-style-row').classList.add('hidden'); }
    redraw(); renderLayerPanel();
  }
  function renderLayerPanel() {
    const list = $('layer-list'); list.innerHTML = '';
    $('layer-count').textContent = String(app.elements.length);
    [...app.elements].reverse().forEach((e, reverseIdx) => {
      const realIdx = app.elements.length - reverseIdx - 1;
      const row = document.createElement('div'); row.className = `layer-row${app.selectedIds.includes(e.id) || app.selectedId === e.id ? ' selected' : ''}${e.hidden ? ' hidden-layer' : ''}`; row.draggable = true; row.dataset.layerId = e.id; row.title = 'Drag to reorder layer';
      row.addEventListener('dragstart', ev => { ev.dataTransfer?.setData('text/plain', e.id); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); document.querySelectorAll('.layer-row.drop-target').forEach(el => el.classList.remove('drop-target')); });
      row.addEventListener('dragover', ev => { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target'); });
      row.addEventListener('dragleave', ev => { if (!row.contains(ev.relatedTarget)) row.classList.remove('drop-target'); });
      row.addEventListener('drop', ev => { ev.preventDefault(); ev.stopPropagation(); row.classList.remove('drop-target'); const sourceId = ev.dataTransfer?.getData('text/plain'); if (sourceId && sourceId !== e.id) reorderLayer(sourceId, e.id); });
      const main = document.createElement('button'); main.className = 'layer-main'; main.title = `Select ${elementName(e, realIdx)}`;
      const sym = document.createElement('span'); sym.className = 'layer-symbol'; sym.textContent = layerSymbol(e.type);
      const label = document.createElement('span'); label.className = 'layer-name'; label.textContent = elementName(e, realIdx); main.append(sym, label); main.addEventListener('click', () => { chooseSelected(e.id); setInspectorTab('properties'); });
      const visibility = document.createElement('button'); visibility.className = 'layer-mini-action'; visibility.title = e.hidden ? 'Show object' : 'Hide object'; visibility.textContent = e.hidden ? '◌' : '◉';
      visibility.addEventListener('click', () => { snapshotHistory(); e.hidden = !e.hidden; redraw(); renderLayerPanel(); scheduleSave(); broadcastScene(); });
      const lock = document.createElement('button'); lock.className = 'layer-mini-action'; lock.title = e.locked ? 'Unlock object' : 'Lock object'; lock.textContent = e.locked ? '▣' : '◇';
      lock.addEventListener('click', () => { snapshotHistory(); e.locked = !e.locked; redraw(); renderLayerPanel(); scheduleSave(); broadcastScene(); });
      const up = document.createElement('button'); up.className = 'layer-mini-action'; up.title = realIdx === app.elements.length - 1 ? 'Already at front' : 'Bring forward'; up.textContent = '↑'; up.disabled = realIdx === app.elements.length - 1;
      up.addEventListener('click', () => moveLayer(e.id, 1));
      const down = document.createElement('button'); down.className = 'layer-mini-action'; down.title = realIdx === 0 ? 'Already at back' : 'Send backward'; down.textContent = '↓'; down.disabled = realIdx === 0;
      down.addEventListener('click', () => moveLayer(e.id, -1));
      row.append(main, visibility, lock, up, down); list.appendChild(row);
    });
    updateCounts();
  }
  function elementName(e, i = 0) { return e.label || (e.type === 'text' ? ((e.text || 'Text').replace(/\s+/g, ' ').slice(0, 22) || 'Text') : e.type === 'image' ? 'Image' : e.type === 'stroke' ? 'Freehand stroke' : e.type === 'code' ? 'Code block' : e.type === 'frame' ? (e.label || 'Frame') : `${e.type[0].toUpperCase()}${e.type.slice(1)} ${i + 1}`); }
  function layerSymbol(type) { return ({ stroke: '✎', eraser: '⌫', rect: '□', ellipse: '○', diamond: '◇', arrow: '↗', line: '／', text: 'T', image: '▧', sticky: '▤', code: '{ }', frame: '▣', connector: '↗' })[type] || '·'; }
  function moveLayer(id, direction) {
    const idx = app.elements.findIndex(e => e.id === id), next = idx + direction; if (idx < 0 || next < 0 || next >= app.elements.length) return;
    snapshotHistory(); const list = [...app.elements]; [list[idx], list[next]] = [list[next], list[idx]]; app.elements = list; renderLayerPanel(); redraw(); scheduleSave(); broadcastScene();
  }
  function reorderLayer(sourceId, targetId) {
    // The layer panel displays front-to-back while the scene array stores back-to-front.
    // Reorder in display order so dragging onto a row visibly moves the layer to that row.
    const visual = [...app.elements].reverse();
    const from = visual.findIndex(e => e.id === sourceId), to = visual.findIndex(e => e.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    snapshotHistory(); const [item] = visual.splice(from, 1); visual.splice(to, 0, item);
    app.elements = visual.reverse();
    renderLayerPanel(); redraw(); scheduleSave(); broadcastScene(); showToast('Layer order updated.');
  }
  function addElement(e) {
    e.id = e.id || uid(); if (e.hidden == null) e.hidden = false; if (e.locked == null) e.locked = false;
    mutate([...app.elements, e]); chooseSelected(e.id);
    // Drawing tools are one-shot: after adding an object, return to the selection tool.
    setTool('select');
  }
  function addAtCenter(type) {
    const rect = viewport.getBoundingClientRect(); const center = { x: (rect.width / 2 - app.panX) / app.zoom, y: (rect.height / 2 - app.panY) / app.zoom };
    const base = { id: uid(), type, x: center.x - 90, y: center.y - 45, w: 180, h: 90, color: app.color, size: app.size, fill: 'none' };
    if (type === 'text') startInlineText({ x: center.x - 35, y: center.y, text: '', fontSize: 22 });
    else if (type === 'sticky') { Object.assign(base, { fill: '#fef3c7', color: '#c9a54a', text: '', textColor: '#55451f', fontSize: 15, w: 200, h: 135 }); addElement(base); startInlineText({ ...base, editId: base.id, type: 'sticky', color: '#55451f' }); }
    else if (type === 'frame') addFrame();
    else if (type === 'image') $('image-file').click();
    else addElement(base);
  }

  const touchDoubleTapHandled = new Set();
  function handleCanvasDoubleTap(ev) {
    if (app.canvasLocked) { showToast('Canvas is locked. Click the lock icon to resume editing.', 1600); return; }
    const p = screenToWorld(ev), hit = hitTest(p);
    if (hit?.type === 'text' || hit?.type === 'sticky' || hit?.type === 'code') {
      startInlineText({ x: hit.x, y: hit.y, text: hit.text, fontSize: hit.fontSize || (hit.type === 'code' ? 13 : hit.type === 'sticky' ? 15 : 22), w: hit.w, h: hit.h, editId: hit.id, type: hit.type, color: hit.textColor || hit.color, fontFamily: hit.fontFamily });
      return;
    }
    if (hit?.type === 'frame') {
      startInlineText({ x: hit.x + 6, y: hit.y - 8, text: hit.label || 'Frame', fontSize: hit.fontSize || 11, w: Math.max(100, hit.w - 12), h: 28, editId: hit.id, inlineType: 'frame-label', color: hit.textColor || hit.color || (app.theme === 'dark' ? '#b5cea8' : '#6c617e'), fontFamily: hit.fontFamily || 'Arial' });
      return;
    }
    if (hit && ['arrow', 'line', 'connector'].includes(hit.type)) {
      startInlineText({ x: hit.x + hit.w / 2 + 4, y: hit.y + hit.h / 2 - 6, text: hit.label || '', fontSize: hit.fontSize || 12, w: 180, h: 28, editId: hit.id, inlineType: 'shape-label', color: hit.textColor || hit.color || app.color, fontFamily: hit.fontFamily || 'Arial' });
      return;
    }
    if (hit && ['rect', 'ellipse', 'diamond'].includes(hit.type)) {
      const b = boundsOf(hit), fontSize = hit.fontSize || 20;
      startInlineText({ x: b.x + 10, y: b.y + b.h / 2 + fontSize * 0.38, text: hit.text || '', fontSize, w: Math.max(80, b.w - 20), h: Math.max(30, b.h - 16), editId: hit.id, inlineType: 'shape-text', color: hit.textColor || (app.theme === 'dark' ? '#e6e6e6' : '#d4d4d4'), fontFamily: hit.fontFamily || 'Arial' });
      return;
    }
    startInlineText({ x: p.x, y: p.y, text: '', fontSize: 22 });
  }
  function editSelectedOnCanvas() {
    const e = elementById(app.selectedId); if (!e) return;
    if (['text', 'sticky', 'code'].includes(e.type)) { startInlineText({ ...e, editId: e.id, type: e.type }); return; }
    if (e.type === 'frame') { startInlineText({ x: e.x + 6, y: e.y - 8, text: e.label || 'Frame', fontSize: e.fontSize || 11, w: Math.max(100, e.w - 12), h: 28, editId: e.id, inlineType: 'frame-label', color: e.textColor || e.color || (app.theme === 'dark' ? '#b5cea8' : '#6c617e'), fontFamily: e.fontFamily || 'Arial' }); return; }
    if (['arrow', 'line', 'connector'].includes(e.type)) { startInlineText({ x: e.x + e.w / 2 + 4, y: e.y + e.h / 2 - 6, text: e.label || '', fontSize: e.fontSize || 12, w: 180, h: 28, editId: e.id, inlineType: 'shape-label', color: e.textColor || e.color || app.color, fontFamily: e.fontFamily || 'Arial' }); return; }
    if (['rect', 'ellipse', 'diamond'].includes(e.type)) {
      const b = boundsOf(e), fs = e.fontSize || 20;
      startInlineText({ x: b.x + 10, y: b.y + b.h / 2 + fs * 0.38, text: e.text || '', fontSize: fs, w: Math.max(80, b.w - 20), h: Math.max(30, b.h - 16), editId: e.id, inlineType: 'shape-text', color: e.textColor || (app.theme === 'dark' ? '#e6e6e6' : '#d4d4d4'), fontFamily: e.fontFamily || 'Arial' });
      return;
    }
    showToast('Double-click a text, shape, code block or sticky note to edit it.');
  }
  function startTouchGesture() {
    const points = [...activePointers.entries()].slice(0, 2);
    if (points.length < 2) return;
    const [a, b] = points.map(([, p]) => p);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const rect = viewport.getBoundingClientRect();
    const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    touchGesture = {
      ids: points.map(([id]) => id), distance, zoom: app.zoom, panX: app.panX, panY: app.panY,
      worldX: (mid.x - rect.left - app.panX) / app.zoom,
      worldY: (mid.y - rect.top - app.panY) / app.zoom
    };
  }
  function updateTouchGesture() {
    if (!touchGesture) return;
    const a = activePointers.get(touchGesture.ids[0]), b = activePointers.get(touchGesture.ids[1]);
    if (!a || !b) return;
    const rect = viewport.getBoundingClientRect();
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    app.zoom = Math.max(.2, Math.min(3.25, touchGesture.zoom * distance / touchGesture.distance));
    app.panX = midX - rect.left - touchGesture.worldX * app.zoom;
    app.panY = midY - rect.top - touchGesture.worldY * app.zoom;
    redraw(); updateCanvasCursor();
  }
  function pointerDown(ev) {
    updateCanvasCursor(ev);
    viewport.focus({ preventScroll: true });
    if (ev.button !== 0 && ev.pointerType !== 'touch' && ev.button !== 1) return;
    if (ev.pointerType === 'touch') {
      const point = { x: ev.clientX, y: ev.clientY, startX: ev.clientX, startY: ev.clientY, downAt: now() };
      activePointers.set(ev.pointerId, point);
      try { canvas.setPointerCapture(ev.pointerId); } catch {}
      if (activePointers.size >= 2) {
        // A second finger switches from drawing/selection into canvas navigation.
        if (app.drawing && app.preview?.type === 'stroke' && app.preview.points?.length > 1) {
          snapshotHistory(); app.elements = [...app.elements, app.preview]; scheduleSave(); broadcastScene();
        }
        app.drawing = null; app.preview = null; app.drag = null;
        lastTouchTap = null;
        startTouchGesture(); ev.preventDefault(); redraw(); return;
      }
      if (app.canvasLocked && activePointers.size < 2 && app.tool !== 'hand' && !app.spaceHeld) { ev.preventDefault(); return; }
      if (lastTouchTap && now() - lastTouchTap.time < 420 && Math.hypot(ev.clientX - lastTouchTap.x, ev.clientY - lastTouchTap.y) < 28) {
        lastTouchTap = null; touchDoubleTapHandled.add(ev.pointerId); suppressNativeDoubleClickUntil = now() + 650;
        app.drawing = null; app.preview = null; app.drag = null;
        handleCanvasDoubleTap(ev); ev.preventDefault(); return;
      }
    }
    const p = screenToWorld(ev); app.pointerId = ev.pointerId;
    if (ev.pointerType !== 'touch') { try { canvas.setPointerCapture?.(ev.pointerId); } catch {} }
    if (app.tool === 'hand' || app.spaceHeld || ev.button === 1) { app.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, px: app.panX, py: app.panY }; return; }
    if (app.canvasLocked) return;
    if (app.tool === 'select') {
      const selected = elementById(app.selectedId);
      if (!ev.shiftKey && app.selectedIds.length <= 1 && selected && isPathElement(selected)) {
        const handle = pathHandleAt(p, selected);
        if (handle) {
          snapshotHistory();
          app.drag = { mode: handle === 'bend' ? 'bend' : handle === 'start' ? 'path-start' : 'path-end', id: selected.id, start: p, base: clone(selected), historySaved: true };
          updateCanvasCursor(ev); return;
        }
      }
      if (!ev.shiftKey && app.selectedIds.length <= 1 && selected && handleHit(p, selected)) {
        snapshotHistory(); app.drag = { mode: 'resize', id: selected.id, start: p, base: clone(selected), historySaved: true }; return;
      }
      const hit = hitTest(p);
      if (hit) {
        if (ev.shiftKey) {
          const ids = new Set(app.selectedIds); if (ids.has(hit.id)) ids.delete(hit.id); else ids.add(hit.id);
          if (ids.size) chooseSelectedKeepMany([...ids].at(-1), [...ids]); else chooseSelected(null);
          redraw(); renderLayerPanel();
          if (ids.has(hit.id) && !hit.locked) { snapshotHistory(); app.drag = { mode: 'move', ids: [...ids], start: p, bases: app.elements.filter(el => ids.has(el.id)).map(clone), historySaved: true }; }
          return;
        }
        if (!app.selectedIds.includes(hit.id)) chooseSelected(hit.id);
        if (!hit.locked) { snapshotHistory(); app.drag = { mode: 'move', ids: app.selectedIds.length > 1 && app.selectedIds.includes(hit.id) ? [...app.selectedIds] : [hit.id], start: p, bases: app.elements.filter(el => (app.selectedIds.length > 1 && app.selectedIds.includes(hit.id) ? app.selectedIds : [hit.id]).includes(el.id)).map(clone), historySaved: true }; }
      } else { chooseSelected(null); app.drag = { mode: 'marquee', start: p, current: p }; }
      return;
    }
    if (app.tool === 'text') { startInlineText({ x: p.x, y: p.y, text: '', fontSize: 22 }); return; }
    app.drawing = { start: p, last: p, pointerType: ev.pointerType, pressure: ev.pressure || 0.5 };
    if (app.tool === 'pen' || app.tool === 'eraser') {
      app.preview = { id: uid(), type: app.tool === 'pen' ? 'stroke' : 'eraser', points: [{ x: p.x, y: p.y, pressure: ev.pressure || 0.5 }], color: app.color, size: app.tool === 'pen' ? app.size : Math.max(6, app.size * 3), pressure: ev.pressure || 0.5 };
    } else {
      app.preview = { id: uid(), type: app.tool, x: p.x, y: p.y, w: 0, h: 0, color: app.color, size: app.size, fill: 'none' };
      if (app.tool === 'sticky') Object.assign(app.preview, { fill: '#fef3c7', color: '#c9a54a', size: 1 });
    }
    redraw();
  }
  function pointerMove(ev) {
    const pointer = activePointers.get(ev.pointerId);
    if (pointer && ev.pointerType === 'touch') { pointer.x = ev.clientX; pointer.y = ev.clientY; }
    updateCanvasCursor(ev);
    if (ev.pointerType === 'touch' && activePointers.size >= 2) { ev.preventDefault(); updateTouchGesture(); return; }
    const p = screenToWorld(ev);
    if (app.drag) {
      const dx = p.x - app.drag.start?.x, dy = p.y - app.drag.start?.y;
      if (app.drag.mode === 'pan') { app.panX = app.drag.px + ev.clientX - app.drag.sx; app.panY = app.drag.py + ev.clientY - app.drag.sy; queueRedraw(); }
      else if (app.drag.mode === 'move') {
        const bases = app.drag.bases || [app.drag.base]; const replacements = new Map(bases.map(old => [old.id, translateElement(old, dx, dy)]));
        app.elements = app.elements.map(e => replacements.get(e.id) || e); queueRedraw();
      }
      else if (app.drag.mode === 'resize') { const old = app.drag.base; const next = resizeElement(old, dx, dy, old); app.elements = app.elements.map(e => e.id === app.drag.id ? next : e); queueRedraw(); }
      else if (app.drag.mode === 'bend') {
        const old = app.drag.base; const next = { ...old, pathStyle: 'curved', bendPoint: { x: p.x, y: p.y } };
        app.elements = app.elements.map(e => e.id === app.drag.id ? next : e); queueRedraw();
      }
      else if (app.drag.mode === 'path-start' || app.drag.mode === 'path-end') {
        const old = app.drag.base, next = { ...old };
        if (app.drag.mode === 'path-start') { next.x = p.x; next.y = p.y; next.w = old.x + old.w - p.x; next.h = old.y + old.h - p.y; }
        else { next.w = p.x - old.x; next.h = p.y - old.y; }
        app.elements = app.elements.map(e => e.id === app.drag.id ? next : e); queueRedraw();
      }
      else if (app.drag.mode === 'marquee') { app.drag.current = p; queueRedraw(); }
      return;
    }
    if (app.drawing && app.preview) {
      if (app.preview.type === 'stroke' || app.preview.type === 'eraser') {
        const samples = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [ev];
        for (const sample of (samples.length ? samples : [ev])) {
          const q = screenToWorld(sample), last = app.preview.points[app.preview.points.length - 1];
          if (Math.hypot(q.x - last.x, q.y - last.y) > 0.45 / app.zoom) app.preview.points.push({ x: q.x, y: q.y, pressure: sample.pressure || ev.pressure || 0.5 });
        }
      } else { app.preview.w = p.x - app.drawing.start.x; app.preview.h = p.y - app.drawing.start.y; }
      app.drawing.last = p; queueRedraw(); return;
    }
    if (app.ws && app.ws.readyState === WebSocket.OPEN && now() - app.lastCursorSent > 42) {
      app.lastCursorSent = now(); sendWS({ type: 'cursor', point: p });
    }
  }
  function pointerUp(ev) {
    const activePoint = activePointers.get(ev.pointerId);
    if (ev.pointerType === 'touch') {
      if (touchGesture) {
        activePointers.delete(ev.pointerId);
        if (activePointers.size >= 2) startTouchGesture(); else touchGesture = null;
        ev.preventDefault(); return;
      }
      if (touchDoubleTapHandled.has(ev.pointerId)) {
        touchDoubleTapHandled.delete(ev.pointerId); activePointers.delete(ev.pointerId); return;
      }
    }
    const wasDrawing = !!app.drawing;
    const wasDragging = !!app.drag;
    if (app.drag) {
      const drag = app.drag; app.drag = null;
      if (drag.mode === 'marquee') {
        const p = screenToWorld(ev), x1 = Math.min(drag.start.x, p.x), y1 = Math.min(drag.start.y, p.y), x2 = Math.max(drag.start.x, p.x), y2 = Math.max(drag.start.y, p.y);
        const contained = app.elements.filter(e => !e.hidden && !e.locked && e.type !== 'frame' && (() => { const b = boundsOf(e); return b.x >= x1 && b.y >= y1 && b.x + b.w <= x2 && b.y + b.h <= y2; })());
        if (contained.length) chooseSelectedKeepMany(contained[contained.length - 1].id, contained.map(e => e.id)); else chooseSelected(null);
      }
      if (['move', 'resize', 'bend', 'path-start', 'path-end'].includes(drag.mode)) { redraw(); renderLayerPanel(); scheduleSave(); broadcastScene(); updateCanvasCursor(ev); }
    }
    if (app.drawing && app.preview) {
      const drawing = app.drawing, element = app.preview; app.drawing = null; app.preview = null;
      if (['rect', 'ellipse', 'diamond', 'sticky', 'frame'].includes(element.type)) {
        const x2 = element.x + element.w, y2 = element.y + element.h;
        element.x = Math.min(element.x, x2); element.y = Math.min(element.y, y2); element.w = Math.abs(element.w); element.h = Math.abs(element.h);
      }
      if (element.type === 'frame') {
        if (Math.abs(element.w) < 60) { element.x = drawing.start.x - 150; element.w = 300; }
        if (Math.abs(element.h) < 50) { element.y = drawing.start.y - 100; element.h = 200; }
        element.label = 'Frame'; element.fontSize = 12; element.size = 1;
      }
      if (element.type === 'sticky') {
        if (Math.abs(element.w) < 35) element.w = 190; if (Math.abs(element.h) < 35) element.h = 125;
        element.text = ''; element.fontSize = 15; element.textColor = '#55451f';
        snapshotHistory(); app.elements = [...app.elements, element]; app.selectedId = element.id; app.selectedIds = [element.id]; updateCounts(); renderLayerPanel(); scheduleSave(); broadcastScene(); chooseSelected(element.id);
        setTool('select');
        startInlineText({ ...element, editId: element.id, type: 'sticky', color: '#55451f' });
      }
      else if (!(['rect', 'ellipse', 'diamond', 'arrow', 'line'].includes(element.type) && Math.abs(element.w) < 3 && Math.abs(element.h) < 3)) {
        snapshotHistory(); app.elements = [...app.elements, element]; app.selectedId = element.id; redraw(); renderLayerPanel(); updateCounts(); scheduleSave(); broadcastScene(); chooseSelected(element.id);
        if (!['stroke', 'eraser'].includes(element.type)) setTool('select');
      } else redraw();
    }
    if (ev.pointerType === 'touch') {
      activePointers.delete(ev.pointerId);
      if (!wasDrawing && !touchGesture && activePoint && Math.hypot(ev.clientX - activePoint.startX, ev.clientY - activePoint.startY) < 12 && now() - activePoint.downAt < 420) lastTouchTap = { x: ev.clientX, y: ev.clientY, time: now() };
    }
    updateCanvasCursor(ev);
  }
  function onWheel(ev) {
    // Route trackpad wheel gestures through the viewport so two-finger swipes pan the board
    // rather than scrolling the page or triggering the browser's back/forward navigation.
    if (ev.target.closest?.('#canvas-text-editor, #text-format-toolbar, #selection-toolbar, .pop-menu, .inspector')) return;
    if (ev.cancelable) ev.preventDefault();
    const scale = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? Math.max(1, viewport.clientHeight) : 1;
    const deltaX = ev.deltaX * scale, deltaY = ev.deltaY * scale;
    if (!ev.ctrlKey && !ev.metaKey) {
      // Trackpad/two-finger scroll translates the infinite canvas on both axes.
      app.panX -= deltaX;
      app.panY -= deltaY;
      queueRedraw(); updateCanvasCursor(ev);
      return;
    }
    // Trackpad pinch gestures are commonly surfaced as Ctrl/Cmd+wheel; zoom around the pointer.
    const before = screenToWorld(ev);
    const factor = Math.exp(-deltaY * 0.0025);
    const next = Math.min(3.25, Math.max(0.2, app.zoom * factor));
    const r = canvas.getBoundingClientRect(); app.zoom = next; app.panX = ev.clientX - r.left - before.x * next; app.panY = ev.clientY - r.top - before.y * next; queueRedraw(); updateCanvasCursor(ev);
  }
  function zoomBy(factor) {

    const r = viewport.getBoundingClientRect(), center = { x: r.width / 2, y: r.height / 2 }, world = { x: (center.x - app.panX) / app.zoom, y: (center.y - app.panY) / app.zoom };
    app.zoom = Math.max(0.2, Math.min(3.25, app.zoom * factor)); app.panX = center.x - world.x * app.zoom; app.panY = center.y - world.y * app.zoom; redraw();
  }
  function fitCanvas() {
    if (!app.elements.length) { app.panX = 0; app.panY = 0; app.zoom = 1; redraw(); return; }
    const b = sceneBounds(app.elements), r = viewport.getBoundingClientRect(), margin = 65;
    app.zoom = Math.max(0.2, Math.min(2.2, Math.min((r.width - margin * 2) / (b.w + margin), (r.height - margin * 2) / (b.h + margin))));
    app.panX = (r.width - b.w * app.zoom) / 2 - b.x * app.zoom; app.panY = (r.height - b.h * app.zoom) / 2 - b.y * app.zoom; redraw();
  }

  function buildShapeAtCenter(type, fill = 'none') {
    const r = viewport.getBoundingClientRect(), x = (r.width / 2 - app.panX) / app.zoom, y = (r.height / 2 - app.panY) / app.zoom;
    return { id: uid(), type, x: x - 85, y: y - 45, w: 170, h: 90, color: app.color, size: app.size, fill };
  }
  function addFrame() {
    const frame = buildShapeAtCenter('frame'); frame.label = 'Frame'; frame.w = 460; frame.h = 310; frame.x -= 145; frame.y -= 110; frame.size = 1;
    addElement(frame);
    startInlineText({ x: frame.x + 6, y: frame.y - 8, text: frame.label, fontSize: frame.fontSize || 11, w: frame.w - 12, h: 28, editId: frame.id, inlineType: 'frame-label', color: frame.textColor || frame.color || (app.theme === 'dark' ? '#b5cea8' : '#6c617e'), fontFamily: frame.fontFamily || 'Arial' });
    showToast('Frame added. Rename it directly on the canvas.');
  }
  function addTextElement(data) { addElement({ id: uid(), type: 'text', x: data.x, y: data.y, text: data.text, color: app.color, size: app.size, fontSize: data.fontSize || 22, label: data.label || '' }); }
  function openModal({ title, eyebrow = 'SKETCHSPACE', subtitle = '', body = '', wide = false, className = '', onSubmit, submitText = 'Add to canvas', onReady, canDismiss }) {
    const root = $('modal-root'); root.innerHTML = '';
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
    const modal = document.createElement('div'); modal.className = `modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`;
    modal.innerHTML = `<div class="modal-header"><div><div class="modal-eyebrow">${escapeHTML(eyebrow)}</div><h2>${escapeHTML(title)}</h2><p class="modal-subtitle">${escapeHTML(subtitle)}</p></div><button class="modal-close" type="button" aria-label="Close">×</button></div><div class="modal-body">${body}</div><div class="modal-actions"><button type="button" class="button button-secondary" data-cancel>Cancel</button><button type="button" class="button button-primary" data-submit>${escapeHTML(submitText)}</button></div>`;
    backdrop.appendChild(modal); root.appendChild(backdrop);
    const allowedToDismiss = () => typeof canDismiss !== 'function' || canDismiss();
    const close = (force = false) => { if (!force && !allowedToDismiss()) return false; root.innerHTML = ''; document.removeEventListener('keydown', onKey); return true; };
    const onKey = e => { if (e.key === 'Escape' && allowedToDismiss()) close(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) modal.querySelector('[data-submit]').click(); };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.modal-close').addEventListener('click', () => close()); modal.querySelector('[data-cancel]').addEventListener('click', () => close()); backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
    modal.querySelector('[data-submit]').addEventListener('click', async () => { const submit = modal.querySelector('[data-submit]'); if (submit.disabled) return; try { const ok = await onSubmit?.(modal, close); if (ok !== false) close(true); } catch (err) { showToast(err.message || 'Something went wrong.'); } });
    onReady?.(modal); return { modal, close };
  }
  function escapeHTML(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  async function addImageFile(file, at = null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please choose an image file.'); return; }
    if (file.size > 15 * 1024 * 1024) { showToast('This image is over 15 MB. Please use a smaller image.'); return; }
    const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Unable to read image.')); r.readAsDataURL(file); });
    const im = await loadImage(dataUrl); const maxW = Math.min(460, Math.max(170, viewport.clientWidth * .55) / app.zoom), scale = Math.min(1, maxW / im.width);
    let p = at;
    if (!p) { const r = viewport.getBoundingClientRect(); p = { x: (r.width / 2 - app.panX) / app.zoom - im.width * scale / 2, y: (r.height / 2 - app.panY) / app.zoom - im.height * scale / 2 }; }
    addElement({ id: uid(), type: 'image', src: dataUrl, x: p.x, y: p.y, w: Math.max(10, im.width * scale), h: Math.max(10, im.height * scale), color: app.color, size: 1, fill: 'none', label: file.name.replace(/\.[^.]+$/, '') });
    setTool('select'); showToast('Image added to canvas. Drag to move or resize.');
  }
  function loadImage(src) { return new Promise((resolve, reject) => {
    if (!src || !/^data:image\//i.test(src)) return reject(new Error('Only embedded image files are supported for local export.'));
    let i = imageCache.get(src);
    if (i && i.complete && i.naturalWidth) return resolve(i);
    if (!i) { i = new Image(); imageCache.set(src, i); }
    i.addEventListener('load', () => resolve(i), { once: true }); i.addEventListener('error', () => reject(new Error('Could not load this image.')), { once: true });
    if (!i.src) i.src = src;
    else if (i.complete && !i.naturalWidth) i.src = src;
  }); }
  function dropAt(ev) { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - app.panX) / app.zoom, y: (ev.clientY - r.top - app.panY) / app.zoom }; }

  function createCodeBlockAtCenter() {
    const r = viewport.getBoundingClientRect();
    const x = (r.width / 2 - app.panX) / app.zoom - 160, y = (r.height / 2 - app.panY) / app.zoom - 75;
    const e = { id: uid(), type: 'code', x, y, w: 340, h: 170, color: '#454545', textColor: '#e6e6e6', size: 1, fill: '#1f1f1f', text: '', language: 'javascript', fontSize: 13, fontFamily: 'Courier New', label: 'javascript code' };
    addElement(e); startInlineText({ ...e, editId: e.id, type: 'code' });
  }
  function openMermaidModal() {
    const example = 'flowchart TD\n  A[React UI] --> B[Express API]\n  B --> C[(MongoDB)]\n  B --> D[Socket.IO]';
    openModal({ title: 'Mermaid to editable shapes', eyebrow: 'DIAGRAM IMPORT', subtitle: 'Paste a simple Mermaid flowchart. The generated nodes and arrows will be individual editable objects.', wide: true, submitText: 'Create diagram', body: `<label>Mermaid source</label><textarea class="field" id="mermaid-source" spellcheck="false">${escapeHTML(example)}</textarea><div class="modal-tip">Supports simple <code>flowchart</code> / <code>graph</code> declarations, node labels using <code>[text]</code>, <code>{text}</code>, <code>(text)</code>, arrows like <code>--&gt;</code>, and optional arrow labels.</div>`, onReady: m => m.querySelector('#mermaid-source').focus(), onSubmit: m => {
      const parsed = parseMermaid(m.querySelector('#mermaid-source').value); if (!parsed.nodes.length) { showToast('No nodes found. Add lines such as A[Start] --> B[End].'); return false; }
      snapshotHistory(); const r = viewport.getBoundingClientRect(); const cx = (r.width / 2 - app.panX) / app.zoom, cy = (r.height / 2 - app.panY) / app.zoom;
      const width = 185, height = 76, x0 = cx - Math.min(470, parsed.nodes.length * 105) / 2, y0 = cy - Math.ceil(parsed.nodes.length / 3) * 70;
      const positions = new Map(); const nodes = parsed.nodes;
      nodes.forEach((node, i) => { const col = i % 3, row = Math.floor(i / 3); const x = x0 + col * (width + 56), y = y0 + row * (height + 58); positions.set(node.id, { x, y }); });
      const generated = [];
      parsed.links.forEach((link, i) => { const a = positions.get(link.from), b = positions.get(link.to); if (!a || !b) return; const sx = a.x + width / 2, sy = a.y + height / 2, ex = b.x + width / 2, ey = b.y + height / 2; generated.push({ id: uid(), type: 'arrow', x: sx, y: sy, w: ex - sx, h: ey - sy, color: '#569cd6', size: 2, label: link.label || '' }); });
      nodes.forEach(node => { const p = positions.get(node.id); const fill = node.shape === 'diamond' ? '#fef3c7' : '#dbeafe'; generated.push({ id: uid(), type: node.shape === 'diamond' ? 'diamond' : 'rect', x: p.x, y: p.y, w: width, h: height, color: '#007acc', size: 2, fill: 'none', label: node.label }); generated.push({ id: uid(), type: 'text', x: p.x + 12, y: p.y + 43, w: width - 24, h: 35, text: node.label, color: app.theme === 'dark' ? '#f5f0ff' : '#292333', size: 1, fontSize: 15, label: `${node.label} label` }); });
      app.elements = [...app.elements, ...generated]; app.selectedId = null; app.selectedIds = []; renderLayerPanel(); redraw(); scheduleSave(); broadcastScene(); updateCounts(); setTool('select'); showToast(`Created ${nodes.length} nodes and ${parsed.links.length} connections.`);
    } });
  }
  function parseMermaid(source) {
    const nodes = new Map(), links = []; const lines = source.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('%%') && !/^(flowchart|graph|direction\b)/i.test(s));
    const nodePattern = /([A-Za-z0-9_]+)\s*(\[\[.*?\]\]|\[.*?\]|\{.*?\}|\(\(.*?\)\)|\(.*?\))/g;
    const addTokenNodes = (line) => { const matches = [...line.matchAll(nodePattern)]; for (const match of matches) { let raw = match[2], shape = 'rect'; if (raw.startsWith('{')) shape = 'diamond'; raw = raw.replace(/^\[\[|\]\]$/g, '').replace(/^\[|\]$/g, '').replace(/^\(\(|\)\)$/g, '').replace(/^\(|\)$/g, '').replace(/^\{|\}$/g, '').trim(); if (!nodes.has(match[1])) nodes.set(match[1], { id: match[1], label: raw || match[1], shape }); } return matches; };
    for (const line of lines) {
      const relation = line.match(/^(.+?)\s*(-->|---|-.->|==>|--\s*[^-]+\s*-->)\s*(.+)$/);
      if (!relation) { addTokenNodes(line); continue; }
      const leftMatches = addTokenNodes(relation[1]), rightMatches = addTokenNodes(relation[3]);
      const getId = (text, matches) => matches.length ? matches[matches.length - 1][1] : text.trim().match(/^[A-Za-z0-9_]+/)?.[0];
      const from = getId(relation[1], leftMatches), to = getId(relation[3], rightMatches);
      if (from && to) {
        if (!nodes.has(from)) nodes.set(from, { id: from, label: from, shape: 'rect' });
        if (!nodes.has(to)) nodes.set(to, { id: to, label: to, shape: 'rect' });
        const labelMatch = relation[2].match(/--\s*(.*?)\s*-->/); links.push({ from, to, label: labelMatch ? labelMatch[1].replace(/\|/g, '').trim() : '' });
      }
    }
    return { nodes: [...nodes.values()], links };
  }

  // Clean base primitives plus a curated collection of distinct, transparent PNG icon assets.
  // The previous generated 1,000+ entries repeated the same rectangle/ellipse with different labels;
  // the catalog now uses real image assets with unique silhouettes instead of fake duplicates.
  const builtinLibrary = [
    { name: 'Process', category: 'Basic shapes', description: 'Rounded process box', visual: '▱', make: () => ({ type: 'rect', w: 165, h: 76, fill: 'none', color: app.color, size: app.size }) },
    { name: 'Decision', category: 'Basic shapes', description: 'Decision diamond', visual: '◇', make: () => ({ type: 'diamond', w: 150, h: 90, fill: 'none', color: app.color, size: app.size }) },
    { name: 'Arrow', category: 'Basic shapes', description: 'Connector arrow', visual: '↗', make: () => ({ type: 'arrow', w: 145, h: 0, color: app.color, size: app.size }) },
    { name: 'Sticky note', category: 'Basic shapes', description: 'A note on the canvas', visual: '▧', make: () => ({ type: 'sticky', w: 190, h: 125, fill: '#fef3c7', color: '#c9a54a', size: 1, text: 'A little thought…', fontSize: 15 }) },
    { name: 'Frame', category: 'Basic shapes', description: 'Named canvas section', visual: '▣', make: () => ({ type: 'frame', w: 420, h: 270, fill: 'none', color: app.theme === 'dark' ? '#81729e' : '#9d91b0', size: 1, label: 'Frame' }) },
    { name: 'Heading', category: 'Basic shapes', description: 'Large canvas text', visual: 'T', make: () => ({ type: 'text', text: 'Your heading', fontSize: 30, color: app.color, size: 1, w: 230, h: 42 }) },
    { name: 'Code block', category: 'Basic shapes', description: 'Code snippet card', visual: '{ }', make: () => ({ type: 'code', w: 300, h: 150, fill: '#1f1f1f', color: '#454545', size: 1, text: 'const idea = "awesome";', language: 'javascript', fontSize: 12 }) },
  ];
  const assetIconCatalog = Array.isArray(window.SKETCHSPACE_ICON_CATALOG) ? window.SKETCHSPACE_ICON_CATALOG : [];
  const iconLibrary = assetIconCatalog.map(icon => ({
    name: icon.name,
    category: icon.category,
    description: icon.description || `${icon.category} component icon · transparent PNG`,
    iconPath: icon.path,
    visual: '',
    make: () => ({ type: 'image', assetPath: icon.path, w: 112, h: 112, color: app.color, size: 1, fill: 'none', label: icon.name }),
  }));
  const shapeCatalog = [...builtinLibrary, ...iconLibrary];
  async function saveSelectedToLibrary() {
    const selected = elementById(app.selectedId); if (!selected) { showToast('Select an object before saving it to your library.'); return; }
    const name = prompt('Name this reusable object', elementName(selected)); if (!name || !name.trim()) return;
    const item = { id: uid(), name: name.trim(), createdAt: now(), element: clone(selected) };
    await dbPut('library', item); await loadLibrary(); showToast('Saved to your local shape library.');
  }
  const indexedShapeCatalog = shapeCatalog.map((item, idx) => ({
    item, idx, search: `${item.name} ${item.description} ${item.category || ''}`.toLowerCase(), category: item.category || 'Basic shapes',
  }));
  const iconAssetDataCache = new Map();
  async function iconAssetAsDataUrl(path) {
    if (iconAssetDataCache.has(path)) return iconAssetDataCache.get(path);
    const response = await fetch(path, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not load icon asset: ${path}`);
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error || new Error('Could not read icon asset.')); reader.readAsDataURL(blob);
    });
    iconAssetDataCache.set(path, dataUrl); return dataUrl;
  }
  async function openLibrary() {
    await loadLibrary();
    const saved = app.library.length ? app.library.map(item => `<button class="library-card saved-library-card" data-saved="${escapeHTML(item.id)}"><span class="library-visual">✦</span><b>${escapeHTML(item.name)}</b><small>Personal library · saved here</small></button>`).join('') : '<div class="modal-tip">Your personal library is empty. Select an object, then choose “Save selected as reusable”.</div>';
    const categories = ['All', 'Basic shapes', ...new Set(iconLibrary.map(item => item.category))];
    const categoryMarkup = categories.map((category, index) => `<button type="button" class="shape-category-chip${index === 0 ? ' active' : ''}" data-catalog-category="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join('');
    const instance = openModal({ title: 'Shape & icon library', eyebrow: 'TRANSPARENT PNG ASSETS', subtitle: 'Distinct, no-background PNG icons for architecture, data, cloud, runtime, AI, security and more. Drag-free insert: choose any icon to place it on the canvas.', wide: true, submitText: 'Done', body: `<input id="shape-library-search" class="shape-library-search" placeholder="Search API gateway, database, Docker, AI…" autocomplete="off"><div class="shape-category-filters" id="shape-category-filters" aria-label="Filter icon categories">${categoryMarkup}</div><div class="section-label" id="shape-library-count">${shapeCatalog.length.toLocaleString()} ITEMS · TRANSPARENT PNGS</div><div class="modal-note-grid shape-catalog-grid" id="shape-catalog-grid" aria-label="System design shapes and icons"></div><div class="section-label saved-library-heading">YOUR SAVED LIBRARY</div><div class="modal-note-grid saved-library-grid">${saved}</div>`, onSubmit: () => true });
    const searchInput = instance.modal.querySelector('#shape-library-search');
    const grid = instance.modal.querySelector('#shape-catalog-grid');
    const count = instance.modal.querySelector('#shape-library-count');
    const categoryBar = instance.modal.querySelector('#shape-category-filters');
    const pageSize = 48;
    let activeCategory = 'All', filtered = indexedShapeCatalog, cursor = 0, isRendering = false;
    const shapeMarkup = (entry) => {
      const item = entry.item;
      const visual = item.iconPath
        ? `<span class="library-visual png-icon-visual"><img src="${escapeHTML(item.iconPath)}" alt="" loading="lazy" decoding="async"></span>`
        : `<span class="library-visual primitive-visual">${escapeHTML(item.visual)}</span>`;
      return `<button class="library-card${item.iconPath ? ' icon-library-card' : ' primitive-library-card'}" data-builtin="${entry.idx}" title="Add ${escapeHTML(item.name)} to canvas">${visual}<b>${escapeHTML(item.name)}</b><small>${escapeHTML(item.category || 'Basic shape')}</small></button>`;
    };
    const appendNext = () => {
      if (isRendering || cursor >= filtered.length) return;
      isRendering = true;
      const stop = Math.min(cursor + pageSize, filtered.length);
      let markup = '';
      for (let i = cursor; i < stop; i++) markup += shapeMarkup(filtered[i]);
      grid.insertAdjacentHTML('beforeend', markup); cursor = stop; isRendering = false;
    };
    const resetFiltered = () => {
      const q = searchInput.value.trim().toLowerCase();
      filtered = indexedShapeCatalog.filter(entry => (activeCategory === 'All' || entry.category === activeCategory) && (!q || entry.search.includes(q)));
      cursor = 0; grid.innerHTML = '';
      count.textContent = `${filtered.length.toLocaleString()} ITEMS${activeCategory !== 'All' ? ` · ${activeCategory.toUpperCase()}` : ''}`;
      appendNext();
    };
    searchInput?.addEventListener('input', resetFiltered);
    categoryBar?.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-catalog-category]'); if (!btn) return;
      activeCategory = btn.dataset.catalogCategory;
      categoryBar.querySelectorAll('[data-catalog-category]').forEach(chip => chip.classList.toggle('active', chip === btn));
      resetFiltered();
    });
    grid?.addEventListener('scroll', () => { if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 240) appendNext(); }, { passive: true });
    grid?.addEventListener('click', async ev => {
      const btn = ev.target.closest('[data-builtin]'); if (!btn) return;
      const item = shapeCatalog[Number(btn.dataset.builtin)]; if (!item) return;
      btn.disabled = true;
      try {
        const template = item.make();
        if (template.assetPath) { template.src = await iconAssetAsDataUrl(template.assetPath); delete template.assetPath; }
        const r = viewport.getBoundingClientRect(), cx = (r.width / 2 - app.panX) / app.zoom, cy = (r.height / 2 - app.panY) / app.zoom;
        const obj = { ...template, id: uid(), x: cx - (template.w || 160) / 2, y: cy - (template.h || 80) / 2 };
        if (obj.type === 'frame') { obj.x -= 120; obj.y -= 90; }
        addElement(obj); instance.close();
      } catch (error) {
        btn.disabled = false; showToast('Could not insert this icon. Please try again.'); console.error(error);
      }
    });
    instance.modal.querySelectorAll('[data-saved]').forEach(btn => btn.addEventListener('click', async () => {
      const item = app.library.find(x => x.id === btn.dataset.saved); if (!item) return;
      const source = clone(item.element); source.id = uid(); const r = viewport.getBoundingClientRect(), cx = (r.width / 2 - app.panX) / app.zoom, cy = (r.height / 2 - app.panY) / app.zoom;
      const b = boundsOf(source); source.x = cx - b.w / 2; source.y = cy - b.h / 2; if (source.points) source.points = source.points.map(p => ({ ...p, x: p.x + source.x - b.x, y: p.y + source.y - b.y })); addElement(source); instance.close();
    }));
    resetFiltered();
  }

  async function openSavedLibrary() {
    await loadLibrary();
    const html = app.library.length ? app.library.map(item => `<div class="layer-row"><button class="layer-main" data-use="${escapeHTML(item.id)}"><span class="layer-symbol">✦</span><span class="layer-name">${escapeHTML(item.name)}</span></button><button class="layer-mini-action" data-delete-library="${escapeHTML(item.id)}" title="Delete saved library item">×</button></div>`).join('') : '<p class="inspector-muted">No reusable objects saved yet.</p>';
    const modal = openModal({ title: 'Your saved library', eyebrow: 'LOCAL LIBRARY', subtitle: 'These reusable objects are only stored in this browser.', submitText: 'Done', body: `<div>${html}</div>` });
    modal.modal.querySelectorAll('[data-use]').forEach(btn => btn.addEventListener('click', () => {
      const item = app.library.find(x => x.id === btn.dataset.use); if (!item) return;
      const e = clone(item.element); const b = boundsOf(e), r = viewport.getBoundingClientRect(), cx = (r.width / 2 - app.panX) / app.zoom, cy = (r.height / 2 - app.panY) / app.zoom; e.id = uid(); e.x = cx - b.w / 2; e.y = cy - b.h / 2; if (e.points) e.points = e.points.map(p => ({ ...p, x: p.x + e.x - b.x, y: p.y + e.y - b.y })); addElement(e); modal.close();
    }));
    modal.modal.querySelectorAll('[data-delete-library]').forEach(btn => btn.addEventListener('click', async () => { await dbDelete('library', btn.dataset.deleteLibrary); await loadLibrary(); modal.close(); openSavedLibrary(); }));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function downloadProject(note = null) {
    const target = note || { title: app.title, elements: app.elements, background: app.canvasBackground, backgroundMode: app.canvasBackgroundMode };
    const blob = new Blob([JSON.stringify({ format: 'sketchspace', version: 2, title: target.title || 'SketchSpace canvas', exportedAt: new Date().toISOString(), elements: target.elements || [], background: target.background || defaultCanvasBackground(), backgroundMode: target.backgroundMode || 'theme' }, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `${sanitizeFilename(target.title)}.sketchspace.json`);
  }
  async function shareCanvasFile() { return shareNoteFile(null); }
  async function shareNoteFile(note = null) {
    if (!note) { await saveActive(); note = { title: app.title || 'SketchSpace canvas', elements: clone(app.elements), background: app.canvasBackground, backgroundMode: app.canvasBackgroundMode }; }
    const title = note.title || 'SketchSpace canvas', filename = `${sanitizeFilename(title)}.sketchspace.json`;
    const json = JSON.stringify({ format: 'sketchspace', version: 2, title, exportedAt: new Date().toISOString(), elements: note.elements || [], background: note.background || defaultCanvasBackground(), backgroundMode: note.backgroundMode || 'theme' }, null, 2);
    try {
      if (typeof File === 'function' && navigator.share && navigator.canShare) {
        const file = new File([json], filename, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ title, files: [file] }); showToast('Editable canvas file shared.'); return; }
      }
    } catch (err) { if (err?.name === 'AbortError') return; }
    downloadBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), filename);
    showToast('Editable canvas file downloaded. A permanent link needs hosted storage.');
  }
  function svgText(text) { return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch])); }
  function elementToSVG(e, background = '#ffffff') {
    if (e.hidden) return '';
    const stroke = e.type === 'eraser' ? background : (e.color || '#d4d4d4'), size = e.size || 3, fill = e.fill && e.fill !== 'none' ? e.fill : 'none';
    if (e.type === 'stroke' || e.type === 'eraser') { const pts = (e.points || []).map(p => `${p.x},${p.y}`).join(' '); return `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${size * (e.type === 'eraser' ? 3.5 : 1)}" stroke-linecap="round" stroke-linejoin="round"/>`; }
    const shapeText = e.text ? `<text x="${e.x + e.w / 2}" y="${e.y + e.h / 2}" text-anchor="middle" dominant-baseline="middle" fill="${e.textColor || (app.theme === 'dark' ? '#e6e6e6' : '#d4d4d4')}" font-family="${svgText((e.fontFamily || 'Arial') + ', Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji')}" font-size="${e.fontSize || 20}" font-weight="${e.fontWeight || 'normal'}" font-style="${e.fontStyle || 'normal'}">${svgText(e.text)}</text>` : '';
    if (e.type === 'rect') { const x = Math.min(e.x, e.x + e.w), y = Math.min(e.y, e.y + e.h), w = Math.abs(e.w), h = Math.abs(e.h); return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="${size}"/>${shapeText}`; }
    if (e.type === 'ellipse') return `<ellipse cx="${e.x + e.w / 2}" cy="${e.y + e.h / 2}" rx="${Math.abs(e.w / 2)}" ry="${Math.abs(e.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${size}"/>${shapeText}`;
    if (e.type === 'diamond') return `<polygon points="${e.x + e.w / 2},${e.y} ${e.x + e.w},${e.y + e.h / 2} ${e.x + e.w / 2},${e.y + e.h} ${e.x},${e.y + e.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${size}"/>${shapeText}`;
    if (e.type === 'line' || e.type === 'arrow' || e.type === 'connector') {
      const x1 = e.x, y1 = e.y, x2 = e.x + e.w, y2 = e.y + e.h, mx = (x1 + x2) / 2;
      const control = pathQuadraticControl(e);
      const usesCurve = e.pathStyle === 'curved' || !!e.bendPoint;
      const d = e.pathStyle === 'elbow' && !e.bendPoint ? `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}` : usesCurve ? `M ${x1} ${y1} Q ${control.x} ${control.y} ${x2} ${y2}` : `M ${x1} ${y1} L ${x2} ${y2}`;
      let angle = e.pathStyle === 'elbow' && !e.bendPoint ? (Math.abs(x2-mx)>0.5 ? (x2>=mx?0:Math.PI) : (y2>=y1?Math.PI/2:-Math.PI/2)) : usesCurve ? Math.atan2(y2-control.y,x2-control.x) : Math.atan2(y2-y1,x2-x1);
      const headLen = 10 + size, ax1=x2-headLen*Math.cos(angle-Math.PI/6), ay1=y2-headLen*Math.sin(angle-Math.PI/6), ax2=x2-headLen*Math.cos(angle+Math.PI/6), ay2=y2-headLen*Math.sin(angle+Math.PI/6);
      const head = e.type === 'line' ? '' : `<path d="M ${x2} ${y2} L ${ax1} ${ay1} M ${x2} ${y2} L ${ax2} ${ay2}" fill="none" stroke="${stroke}" stroke-width="${size}" stroke-linecap="round"/>`;
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${size}" stroke-linecap="round" stroke-linejoin="round"/>${head}${e.label ? `<text x="${(x1+x2)/2+4}" y="${(y1+y2)/2-6}" font-size="11" fill="${stroke}">${svgText(e.label)}</text>` : ''}`;
    }
    if (e.type === 'text') { const fs = e.fontSize || 21; return (e.text || '').split('\n').map((line, i) => `<text x="${e.x}" y="${e.y + i * fs * 1.3}" fill="${stroke}" font-family="${svgText((e.fontFamily || 'Arial') + ', Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji')}" font-weight="${e.fontWeight || 'normal'}" font-style="${e.fontStyle || 'normal'}" font-size="${fs}">${svgText(line)}</text>`).join(''); }
    if (e.type === 'image') return `<image href="${svgText(e.src || '')}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" preserveAspectRatio="none"/>`;
    if (e.type === 'sticky') { const text = (e.text || '').split('\n').map((line, i) => `<text x="${e.x + 12}" y="${e.y + 25 + i * 20}" font-size="15" fill="#55451f">${svgText(line)}</text>`).join(''); return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="4" fill="${e.fill || '#fef3c7'}" stroke="${stroke}"/>${text}`; }
    if (e.type === 'code') { const text = (e.text || '').split('\n').map((line, i) => `<text x="${e.x + 12}" y="${e.y + 38 + i * 18}" font-size="12" fill="#e6e6e6" font-family="monospace">${svgText(line)}</text>`).join(''); return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="8" fill="${e.fill || '#1f1f1f'}" stroke="#454545"/><text x="${e.x + 12}" y="${e.y + 20}" font-size="10" fill="#569cd6">${svgText(e.language || 'code')}</text>${text}`; }
    if (e.type === 'frame') return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="none" stroke="${stroke}" stroke-dasharray="7 4" stroke-width="1.5"/><text x="${e.x + 5}" y="${e.y - 8}" font-size="11" fill="${stroke}">${svgText(e.label || 'Frame')}</text>`;
    return '';
  }
  function svgForElements(elements, title = 'SketchSpace', background = app.canvasBackground || defaultCanvasBackground()) {
    const b = sceneBounds(elements), margin = 32, w = Math.ceil(b.w + margin * 2), h = Math.ceil(b.h + margin * 2);
    const body = elements.filter(e => e.type === 'frame').concat(elements.filter(e => e.type !== 'frame')).map(e => elementToSVG(e, background)).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - margin} ${b.y - margin} ${w} ${h}"><title>${svgText(title)}</title><rect x="${b.x - margin}" y="${b.y - margin}" width="${w}" height="${h}" fill="${background}"/>${body}</svg>`;
  }
  async function makeExportCanvas() {
    await Promise.all(app.elements.filter(e => e.type === 'image' && e.src).map(e => loadImage(e.src).catch(() => null)));
    const b = sceneBounds(app.elements), margin = 32, width = Math.min(7000, Math.max(1, Math.ceil(b.w + margin * 2))), height = Math.min(7000, Math.max(1, Math.ceil(b.h + margin * 2)));
    const out = document.createElement('canvas'); out.width = width; out.height = height; const c = out.getContext('2d'); c.fillStyle = app.canvasBackground || defaultCanvasBackground(); c.fillRect(0, 0, width, height); c.save(); c.translate(margin - b.x, margin - b.y); drawElements(c, app.elements, { background: app.canvasBackground || defaultCanvasBackground() }); c.restore(); return out;
  }
  async function exportPNG() {
    try { setStatus('Preparing export…', 'saving'); const out = await makeExportCanvas(); out.toBlob(blob => { if (blob) downloadBlob(blob, `${sanitizeFilename(app.title)}.png`); setStatus('Saved on this device'); }); }
    catch { showToast('PNG export failed. Try exporting the editable project instead.'); }
  }
  function exportSVG() { const svg = svgForElements(app.elements, app.title); downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${sanitizeFilename(app.title)}.svg`); }
  async function exportPDF() {
    try {
      const svg = svgForElements(app.elements, app.title); const w = window.open('', '_blank');
      if (!w) { showToast('Allow pop-ups for this site to print the PDF.'); return; }
      w.document.open(); w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHTML(app.title)}</title><style>@page{margin:8mm;size:auto}html,body{margin:0;background:#fff}svg{width:100%;height:auto;max-height:95vh;object-fit:contain}body{display:flex;justify-content:center;align-items:center;min-height:100vh}</style></head><body>${svg}<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300));<\/script></body></html>`); w.document.close();
    } catch { showToast('Could not open the print window. Allow pop-ups and try again.'); }
  }
  async function importProject(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { showToast('Project file is over 25 MB.'); return; }
    try {
      const raw = JSON.parse(await file.text());
      let elements = Array.isArray(raw.elements) ? raw.elements : Array.isArray(raw.scene?.elements) ? raw.scene.elements : null;
      if (!elements) throw new Error('This file has no supported drawing elements.');
      const title = raw.title || file.name.replace(/\.(sketchspace\.)?json$|\.excalidraw$/i, '') || 'Imported canvas';
      if (raw.type === 'excalidraw' || elements.some(e => e.strokeColor || e.backgroundColor || e.versionNonce)) elements = convertExcalidraw(elements, raw.files || {});
      elements = elements.map(e => ({ ...e, id: e.id || uid(), hidden: !!e.hidden, locked: !!e.locked }));
      const importedBackground = validHexColor(raw.background) ? raw.background : defaultCanvasBackground();
      const note = { id: uid(), title, elements, background: importedBackground, backgroundMode: raw.backgroundMode === 'theme' || raw.backgroundMode === 'custom' ? raw.backgroundMode : canvasBackgroundModeFor({ background: importedBackground }), createdAt: now(), updatedAt: now() }; await dbPut('notes', note); await loadAllNotes(); openNote(note); showToast(`Imported ${elements.length} objects.`);
    } catch (err) { showToast(err.message || 'Could not read that project file.'); }
  }
  function convertExcalidraw(elements, files = {}) {
    return elements.filter(e => !e.isDeleted).map(e => {
      const map = { rectangle: 'rect', ellipse: 'ellipse', diamond: 'diamond', arrow: 'arrow', line: 'line', freedraw: 'stroke', text: 'text', image: 'image' };
      const type = map[e.type] || 'rect'; const points = (e.points || []).map(p => ({ x: (e.x || 0) + p[0], y: (e.y || 0) + p[1] }));
      let src = e.src || '';
      if (type === 'image' && e.fileId && files[e.fileId]) { const file = files[e.fileId]; src = file.dataURL || file.dataUrl || ''; }
      const result = { id: uid(), type, x: e.x || 0, y: e.y || 0, w: e.width || 1, h: e.height || 1, color: e.strokeColor || '#d4d4d4', size: e.strokeWidth || 2, fill: e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : 'none', label: e.name || '', text: e.text || '', fontSize: e.fontSize || 20, points, src, hidden: false, locked: false };
      if (type === 'stroke') result.points = points;
      return result;
    });
  }

  function sendWS(data) {
    if (app.ws && app.ws.readyState === WebSocket.OPEN) {
      try { app.ws.send(JSON.stringify(data)); } catch { /* socket may close between readyState and send */ }
    }
  }
  function broadcastScene() {
    if (!app.roomId || !app.ws || app.ws.readyState !== WebSocket.OPEN || now() - app.lastSceneSent < 45) {
      if (app.roomId) { clearTimeout(app.pendingSave); app.pendingSave = setTimeout(() => { app.lastSceneSent = now(); sendWS({ type: 'scene', elements: app.elements }); }, 70); }
      return;
    }
    app.lastSceneSent = now(); sendWS({ type: 'scene', elements: app.elements });
  }
  function disconnectRoom(show = true) {
    if (app.ws) { try { app.ws.close(); } catch {} }
    app.ws = null; app.roomId = ''; app.members = []; app.remoteCursors.clear(); renderRemoteCursors(); $('room-status').classList.add('hidden'); $('collab-button').classList.remove('connected');
    if (show) showToast('Left the collaboration room. Your local copy is still saved.');
  }
  function joinRoom(roomId, displayName, hooks = {}) {
    if (!displayName.trim()) { showToast('Please enter a display name first.'); hooks.onError?.('Please enter a display name first.'); return; }
    let receivedRoomState = false; let failureNotified = false;
    const notifyFailure = message => { if (!receivedRoomState && !failureNotified) { failureNotified = true; hooks.onError?.(message); } };
    disconnectRoom(false); app.displayName = displayName.trim().slice(0, 40); app.roomId = roomId.trim().slice(0, 80); app.roomJoinPending = true; app.selectedId = null; app.selectedIds = [];
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; const ws = new WebSocket(`${proto}//${location.host}/ws`); app.ws = ws;
    ws.addEventListener('open', () => { sendWS({ type: 'join', roomId: app.roomId, name: app.displayName, elements: app.elements }); });
    ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'room:state') {
        app.members = msg.members || []; if (!msg.isNew && Array.isArray(msg.elements)) { app.suppressSave = true; app.elements = msg.elements; app.suppressSave = false; }
        app.roomJoinPending = false; receivedRoomState = true; updateRoomUI(); redraw(); renderLayerPanel(); scheduleSave(); showToast(msg.isNew ? `Room ${app.roomId} created.` : `Joined room ${app.roomId}.`); hooks.onRoomState?.(msg, app.roomId);
      } else if (msg.type === 'room:members') { app.members = msg.members || []; updateRoomUI(); }
      else if (msg.type === 'scene') { app.suppressSave = true; app.elements = Array.isArray(msg.elements) ? msg.elements : []; app.suppressSave = false; app.selectedIds = app.selectedIds.filter(id => elementById(id)); app.selectedId = elementById(app.selectedId)?.id || app.selectedIds.at(-1) || null; redraw(); renderLayerPanel(); scheduleSave(); updateCounts(); }
      else if (msg.type === 'cursor') { app.remoteCursors.set(msg.id, { ...msg.point, name: msg.name, color: msg.color || '#569cd6' }); renderRemoteCursors(); }
      else if (msg.type === 'peer:leave') { app.remoteCursors.delete(msg.id); renderRemoteCursors(); }
      else if (msg.type === 'error') { const message = msg.message || 'Collaboration error.'; showToast(message); notifyFailure(message); }
    });
    ws.addEventListener('close', () => { if (app.ws === ws) { app.ws = null; app.roomId = ''; app.members = []; updateRoomUI(); renderRemoteCursors(); if (app.view === 'editor') setStatus('Saved on this device'); notifyFailure('The connection closed before the room was ready. Please try again.'); } });
    ws.addEventListener('error', () => { const message = 'Collaboration server unavailable. Check that the public app service is running.'; showToast(message); notifyFailure(message); });
  }
  function updateRoomUI() {
    const connected = !!app.roomId && !!app.ws && app.ws.readyState === WebSocket.OPEN;
    const button = $('collab-button');
    $('room-status').classList.toggle('hidden', !connected);
    $('room-member-count').textContent = String(app.members.length);
    button.classList.toggle('connected', connected);
    button.dataset.connected = String(connected);

    // Keep the icon node stable while room membership updates. Replacing the entire
    // button HTML on every room:members event caused the share glyph to be lost or
    // rendered before icon styles were applied in some browsers.
    const iconNode = button.querySelector('.people-icon');
    if (iconNode && !iconNode.querySelector('svg')) {
      iconNode.innerHTML = ICONS.share || '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.7 6.6-4.4M8.7 13.3l6.6 4.4"/></svg>';
    }
    const label = connected ? `${app.members.length} online` : 'Collaborate';
    const labelNode = button.querySelector('.collab-button-text');
    if (labelNode) labelNode.textContent = label;
    button.setAttribute('aria-label', connected ? `Share room, ${label}` : 'Collaborate');
    button.title = connected ? `Share live room ${app.roomId}` : 'Create or join a live room';
  }
  function renderRemoteCursors() {
    const layer = $('cursor-layer'); layer.innerHTML = '';
    for (const [id, p] of app.remoteCursors.entries()) {
      const div = document.createElement('div'); div.className = 'remote-cursor'; div.style.left = `${p.x * app.zoom + app.panX}px`; div.style.top = `${p.y * app.zoom + app.panY}px`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 20 24'); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M2 1 L18 14 L10 15 L7 23 Z'); path.setAttribute('fill', p.color); svg.appendChild(path);
      const label = document.createElement('span'); label.textContent = p.name || 'Collaborator'; label.style.background = p.color; div.append(svg, label); layer.appendChild(div);
    }
  }
  function shareRoom() {
    if (!app.roomId) { showCollaborationModal(); return; }
    const link = `${location.origin}/?room=${encodeURIComponent(app.roomId)}`;
    openModal({ title: 'Share this canvas', eyebrow: 'LIVE ROOM', subtitle: 'Anyone with this link can join and edit while the room is active. Only the display name is required.', submitText: 'Copy invite link', body: `<div class="connected-pill"><i class="online-dot"></i> Connected to room <strong>${escapeHTML(app.roomId)}</strong></div><div class="share-url-box"><input class="field" id="share-link" readonly value="${escapeHTML(link)}"></div><div class="member-list">${app.members.map(m => `<span class="member-chip"><span class="member-avatar">${escapeHTML((m.name || '?')[0].toUpperCase())}</span>${escapeHTML(m.name)}${m.id === app.ws?.id ? ' · you' : ''}</span>`).join('')}</div><div class="modal-tip">This room is temporary and lives in the server's memory. Your personal notes are still saved locally in this browser. Avoid sharing confidential content in public rooms.</div>`, onReady: m => { m.querySelector('#share-link').select(); }, onSubmit: async m => { const copied = await copyText(link); if (!copied) { m.querySelector('#share-link')?.select(); showToast('Could not copy automatically. The invite link is selected; copy it manually.'); return false; } showToast('Invite link copied.'); return true; } });
  }
  function showCollaborationModal() {
    const params = new URLSearchParams(location.search); const queryRoom = params.get('room') || '';
    let phase = 'form'; let inviteLink = ''; let joining = false;
    const body = `<div class="collaboration-form"><div class="collaboration-field-group"><label for="collab-name">Your display name</label><input class="field" id="collab-name" placeholder="e.g. Ayush" maxlength="40" autocomplete="nickname" value="${escapeHTML(app.displayName || '')}"></div><div class="collaboration-field-group"><label for="collab-room">Room ID <span class="field-hint">(optional · leave blank to create a new room)</span></label><input class="field" id="collab-room" placeholder="Paste a room ID or invite code" maxlength="80" autocomplete="off" value="${escapeHTML(queryRoom)}"></div><div class="modal-tip collaboration-notice">Live drawing syncs while the room is active, but the server does not save it permanently. When everyone leaves or the server restarts, the room is cleared. Each participant's personal canvas stays saved in their own browser.</div></div>`;
    const modalHandle = openModal({
      title: 'Draw together', eyebrow: 'SKETCHSPACE COLLABORATION', subtitle: 'Use your display name to create a room or join someone. No account or password is needed.',
      className: 'collaboration-modal', submitText: queryRoom ? 'Join room' : 'Create room', body,
      canDismiss: () => phase !== 'invite',
      onReady: m => { m.querySelector('#collab-name').focus(); },
      onSubmit: async (m) => {
        if (phase === 'invite') {
          const copied = await copyText(inviteLink);
          if (!copied) { m.querySelector('#share-link')?.select(); showToast('Could not copy automatically. The invite link is selected; copy it manually.'); return false; }
          showToast('Invite link copied.');
          return true;
        }
        if (joining) return false;
        const name = m.querySelector('#collab-name').value.trim();
        let room = m.querySelector('#collab-room').value.trim();
        if (!name) { showToast('Enter the name you want other participants to see.'); m.querySelector('#collab-name').focus(); return false; }
        const isCreating = !room;
        if (isCreating) room = `room-${uid()}-${uid().slice(0, 4)}`;
        joining = true;
        const submit = m.querySelector('[data-submit]');
        submit.disabled = true; submit.textContent = 'Connecting…';
        m.querySelector('#collab-name').disabled = true; m.querySelector('#collab-room').disabled = true;
        m.querySelector('.modal-subtitle').textContent = 'Connecting to your temporary room…';
        const restoreForm = message => {
          if (!m.isConnected || phase !== 'form') return;
          joining = false; submit.disabled = false; submit.textContent = queryRoom ? 'Join room' : 'Create room';
          m.querySelector('#collab-name').disabled = false; m.querySelector('#collab-room').disabled = false;
          m.querySelector('.modal-subtitle').textContent = 'Use your display name to create a room or join someone. No account or password is needed.';
          if (message) showToast(message);
        };
        try {
          if (!app.activeId) await createNote(`Shared canvas · ${room.slice(0, 8)}`);
          joinRoom(room, name, {
            onRoomState: (msg, connectedRoomId) => {
              if (!m.isConnected || phase !== 'form') return;
              phase = 'invite'; joining = false;
              inviteLink = `${location.origin}/?room=${encodeURIComponent(connectedRoomId || room)}`;
              m.querySelector('.modal-eyebrow').textContent = 'SKETCHSPACE · ROOM READY';
              m.querySelector('h2').textContent = 'Your room is ready';
              m.querySelector('.modal-subtitle').textContent = 'Copy the invite link below and send it to your collaborator. This dialog will close after the link is copied.';
              m.querySelector('.modal-body').innerHTML = `<div class="room-ready-card"><div class="connected-pill"><i class="online-dot"></i><span>Connected to room</span><strong>${escapeHTML(connectedRoomId || room)}</strong></div><label class="room-link-label" for="share-link">Invite link</label><div class="share-url-box"><input class="field" id="share-link" readonly value="${escapeHTML(inviteLink)}"></div><div class="modal-tip collaboration-notice">Keep this link private. Anyone with it can join and edit while the room is active. Shared room content is temporary; personal notes remain stored in your own browser.</div></div>`;
              submit.disabled = false; submit.textContent = 'Copy invite link';
              const cancel = m.querySelector('[data-cancel]'); if (cancel) cancel.hidden = true;
              const closeButton = m.querySelector('.modal-close'); if (closeButton) closeButton.hidden = true;
              m.querySelector('#share-link').select();
              showToast(msg.isNew ? 'Room created. Copy the invite link to finish.' : 'Room joined. Copy the invite link to finish.');
            },
            onError: message => restoreForm(message || 'Could not connect to that room. Please try again.')
          });
        } catch (err) { restoreForm(err.message || 'Could not create the room. Please try again.'); }
        return false;
      }
    });
    return modalHandle;
  }
  async function copyText(text) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* use the selection fallback below */ }
    const temp = document.createElement('textarea'); temp.value = text; temp.setAttribute('aria-hidden', 'true');
    Object.assign(temp.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' }); document.body.appendChild(temp); temp.select();
    let copied = false; try { copied = document.execCommand('copy'); } catch { copied = false; }
    temp.remove(); return !!copied;
  }

  function initColors() {
    const wrap = $('color-swatches'); wrap.innerHTML = '';
    for (const color of COLORS) { const b = document.createElement('button'); b.className = `color-swatch${app.color === color ? ' active' : ''}`; b.style.background = color; b.title = color; b.setAttribute('aria-label', `Ink ${color}`); b.addEventListener('click', () => { app.color = color; $('custom-color').value = /^#[0-9a-f]{6}$/i.test(color) ? color : '#d4d4d4'; initColors(); if (app.selectedId) { const e = elementById(app.selectedId); if (e) { snapshotHistory(); e.color = color; redraw(); renderLayerPanel(); scheduleSave(); broadcastScene(); chooseSelected(e.id); } } }); wrap.appendChild(b); }
  }
  function clearCanvas() {
    if (!app.elements.length) return;
    if (!confirm('Clear every object from this canvas? This action can be undone with Ctrl+Z.')) return;
    mutate([]); chooseSelected(null); showToast('Canvas cleared. Press Ctrl+Z to undo.');
  }
  async function deleteActiveCanvas() {
    if (!app.activeId) { showToast('This canvas has not been saved yet.'); return; }
    const activeId = app.activeId, activeTitle = app.title || 'Untitled canvas';
    if (!confirm(`Delete “${activeTitle}” from this device? This cannot be undone.`)) return;
    clearTimeout(app.saveTimer); app.saveTimer = null;
    try { await dbDelete('notes', activeId); }
    catch { showToast('Could not delete this canvas from local storage.'); return; }
    disconnectRoom(false); app.activeId = null; app.elements = []; app.selectedId = null; app.selectedIds = []; app.inlineText = null;
    $('canvas-text-editor').classList.add('hidden'); $('text-format-toolbar').classList.add('hidden'); $('selection-toolbar').classList.add('hidden');
    await loadAllNotes(); switchView('home'); showToast('Canvas deleted from this device.');
  }
  function deleteSelected() {
    if (!app.selectedIds.length && !app.selectedId) return;
    const ids = new Set(app.selectedIds.length ? app.selectedIds : [app.selectedId]); mutate(app.elements.filter(e => !ids.has(e.id))); chooseSelected(null);
  }
  function duplicateSelected() {
    const ids = app.selectedIds.length ? app.selectedIds : (app.selectedId ? [app.selectedId] : []); if (!ids.length) return;
    const copies = app.elements.filter(e => ids.includes(e.id)).map(e => { const copy = translateElement(clone(e), 22, 22); copy.id = uid(); copy.label = copy.label ? `${copy.label} copy` : ''; return copy; });
    mutate([...app.elements, ...copies]); chooseSelectedKeepMany(copies[copies.length - 1].id, copies.map(e => e.id));
  }
  function updateSelectedField(key, value) {
    const e = elementById(app.selectedId); if (!e) return;
    snapshotHistory();
    if (key === 'size') e.size = Number(value);
    else if (key === 'pathStyle') { e.pathStyle = value; if (value !== 'curved') delete e.bendPoint; }
    else e[key] = value;
    redraw(); renderLayerPanel(); scheduleSave(); broadcastScene();
    if (key === 'pathStyle') updateSelectionToolbar();
  }
  function importAtDashboard(event) {
    const file = event.target.files?.[0]; if (file) importProject(file); event.target.value = '';
  }

  const ICONS = window.SKETCHSPACE_UI_ICONS || {};
  function polishIcons() {
    const shortcuts = { select: 'V', hand: 'H', pen: 'P', eraser: 'E', rect: 'R', ellipse: 'O', diamond: 'D', arrow: 'A', line: 'L', text: 'T', sticky: 'N', frame: 'F', image: 'I', 'add-frame': 'F', 'add-code': 'K', 'add-mermaid': 'M' };
    document.querySelectorAll('.tool-btn, .tool-overflow-item').forEach(btn => {
      const key = btn.dataset.icon || btn.dataset.tool || btn.id;
      let glyph = btn.querySelector('.tool-glyph');
      if (glyph && ICONS[key]) glyph.innerHTML = ICONS[key];
      const shortcut = btn.dataset.shortcut || shortcuts[key];
      if (btn.classList.contains('tool-btn') && shortcut && key !== 'tools-more-button') {
        btn.dataset.shortcut = shortcut;
        let kbd = btn.querySelector('.tool-shortcut');
        if (!kbd) { kbd = document.createElement('kbd'); kbd.className = 'tool-shortcut'; btn.appendChild(kbd); }
        kbd.textContent = shortcut;
        btn.title = `${btn.getAttribute('aria-label') || key} (${shortcut})`;
      }
    });
    const actions = { duplicate: 'duplicate', front: 'front', delete: 'delete' };
    document.querySelectorAll('[data-selection-action]').forEach(btn => { const icon = btn.querySelector('.action-icon'); if (icon) icon.innerHTML = ICONS[actions[btn.dataset.selectionAction]] || ''; });
    const menuIconMap = { 'toggle-inspector': 'layers', 'show-shortcuts': 'help', 'share-canvas-file': 'share', 'more-import': 'import', 'more-library': 'open-library', 'more-mermaid': 'add-mermaid', 'more-code': 'add-code', 'more-frame': 'add-frame', 'more-clear': 'delete', 'more-delete-canvas': 'delete' };
    Object.entries(menuIconMap).forEach(([id, iconKey]) => {
      const item = $(id), icon = item?.querySelector('span:first-child');
      if (icon && ICONS[iconKey]) { icon.innerHTML = ICONS[iconKey]; icon.classList.add('menu-item-icon'); }
    });
    const brandMark = document.querySelector('.brand-mark:not(.small)');
    if (brandMark && ICONS.pen) brandMark.innerHTML = ICONS.pen;
    const backGlyph = $('back-home')?.querySelector('.back-home-glyph');
    if (backGlyph) backGlyph.innerHTML = ICONS['back-home'];
    const exportIcon = $('export-menu-button')?.querySelector('.button-icon');
    if (exportIcon) exportIcon.innerHTML = ICONS.export;
    const exportMenuIcons = { png: 'png', svg: 'svg', pdf: 'pdf', project: 'project' };
    document.querySelectorAll('[data-export]').forEach(item => {
      const icon = item.querySelector('.menu-entry-icon');
      if (icon && ICONS[exportMenuIcons[item.dataset.export]]) {
        icon.innerHTML = ICONS[exportMenuIcons[item.dataset.export]];
      }
    });
    const importMenuIcon = $('export-menu')?.querySelector('.export-import-entry .menu-entry-icon');
    if (importMenuIcon) importMenuIcon.innerHTML = ICONS.import;
    const shareIcon = $('collab-button')?.querySelector('.people-icon');
    if (shareIcon) shareIcon.innerHTML = ICONS.share;
    const undoIcon = $('undo')?.querySelector('.action-icon'); if (undoIcon) undoIcon.innerHTML = ICONS.undo;
    const redoIcon = $('redo')?.querySelector('.action-icon'); if (redoIcon) redoIcon.innerHTML = ICONS.redo;
    const menuUndoIcon = $('tool-undo-menu')?.querySelector('.tool-glyph'); if (menuUndoIcon) menuUndoIcon.innerHTML = ICONS.undo;
    const menuRedoIcon = $('tool-redo-menu')?.querySelector('.tool-glyph'); if (menuRedoIcon) menuRedoIcon.innerHTML = ICONS.redo;
    const moreButton = $('editor-more-button');
    if (moreButton) moreButton.innerHTML = ICONS['tools-more-button'] || ICONS.ellipsis || '';
    const selectedMore = $('selection-more-button')?.querySelector('.action-icon');
    if (selectedMore) selectedMore.innerHTML = ICONS['tools-more-button'] || ICONS.ellipsis || '';
    const emojiIcon = $('emoji-insert-button')?.querySelector('.emoji-button-icon');
    if (emojiIcon) emojiIcon.innerHTML = ICONS.emoji || ICONS['face-smile'] || '<span aria-hidden=\"true\">☺</span>';
    const themeHome = $('theme-home'); if (themeHome && !themeHome.innerHTML.trim()) themeHome.innerHTML = ICONS.theme || ICONS.sun || '';
    setCanvasLocked(app.canvasLocked);
    setTheme(app.theme);
  }

  // Wire UI
  $('create-note-top').addEventListener('click', () => createNote()); $('create-note-hero').addEventListener('click', () => createNote()); $('create-note-empty').addEventListener('click', () => createNote());
  $('brand-home').addEventListener('click', ev => { ev.preventDefault(); goHome(); }); $('back-home').addEventListener('click', goHome);
  $('theme-home').addEventListener('click', () => setTheme(app.theme === 'dark' ? 'light' : 'dark')); $('theme-editor').addEventListener('click', () => setTheme(app.theme === 'dark' ? 'light' : 'dark'));
  $('toggle-canvas-lock')?.addEventListener('click', () => setCanvasLocked(!app.canvasLocked));
  $('toggle-inspector').addEventListener('click', toggleInspector);
  $('show-shortcuts').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); showShortcuts(); });
  $('selection-toolbar').querySelectorAll('[data-selection-action]').forEach(btn => btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); const action = btn.dataset.selectionAction; if (action === 'delete') deleteSelected(); else if (action === 'duplicate') duplicateSelected(); }));
  $('selection-more-button').addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); $('selection-more-menu').classList.toggle('hidden'); });
  $('selection-more-menu').querySelectorAll('[data-object-action]').forEach(btn => btn.addEventListener('click', ev => {
    ev.preventDefault(); ev.stopPropagation(); const action = btn.dataset.objectAction; const e = elementById(app.selectedId); $('selection-more-menu').classList.add('hidden');
    if (action === 'delete') deleteSelected();
    else if (action === 'duplicate') duplicateSelected();
    else if (action === 'front' && e) moveLayer(e.id, 1);
    else if (action === 'back' && e) moveLayer(e.id, -1);
    else if (action === 'lock' && e) updateSelectedField('locked', !e.locked);
    else if (action === 'library') saveSelectedToLibrary();
    else if (action === 'edit' && e) editSelectedOnCanvas();
  }));
  $('object-color').addEventListener('input', ev => updateSelectedField('color', ev.target.value));
  $('object-fill').addEventListener('change', ev => updateSelectedField('fill', ev.target.value));
  $('object-size').addEventListener('input', ev => updateSelectedField('size', ev.target.value));
  $('object-path-style')?.addEventListener('change', ev => updateSelectedField('pathStyle', ev.target.value)); $('selected-path-style')?.addEventListener('change', ev => updateSelectedField('pathStyle', ev.target.value));
  $('path-style-quick')?.querySelectorAll('[data-path-style-quick]').forEach(button => button.addEventListener('click', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const selected = elementById(app.selectedId);
    if (selected && ['arrow', 'line', 'connector'].includes(selected.type)) updateSelectedField('pathStyle', button.dataset.pathStyleQuick);
  }));
  $('canvas-bg-color')?.addEventListener('input', ev => { if (validHexColor(ev.target.value)) { app.canvasBackground = ev.target.value; app.canvasBackgroundMode = 'custom'; updateCanvasBackgroundControls(); redraw(); scheduleSave(); broadcastScene(); renderDashboard(); } });
  $('canvas-bg-follow-theme')?.addEventListener('click', () => { app.canvasBackgroundMode = 'theme'; app.canvasBackground = defaultCanvasBackground(); updateCanvasBackgroundControls(); redraw(); scheduleSave(); broadcastScene(); renderDashboard(); showToast('Canvas background now follows the theme.'); });
  $('object-label').addEventListener('change', ev => updateSelectedField('label', ev.target.value));
  $('canvas-text-editor').addEventListener('input', resizeInlineTextArea);
  $('canvas-text-editor').addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'b') { ev.preventDefault(); applyTextFormat('fontWeight', app.inlineText?.fontWeight === 'bold' ? 'normal' : 'bold'); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'i') { ev.preventDefault(); applyTextFormat('fontStyle', app.inlineText?.fontStyle === 'italic' ? 'normal' : 'italic'); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finishInlineText(true); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finishInlineText(false); }
  });
  $('canvas-text-editor').addEventListener('blur', () => { if (app.inlineText) setTimeout(() => { if (app.inlineText && document.activeElement !== $('canvas-text-editor') && !$('text-format-toolbar').contains(document.activeElement)) finishInlineText(false); }, 0); });
  $('inline-font-family').addEventListener('change', ev => { const value = ev.target.value; applyTextFormat('fontFamily', value); if (app.inlineText) requestAnimationFrame(() => $('canvas-text-editor').focus({ preventScroll: true })); });
  $('font-size-down').addEventListener('pointerdown', ev => ev.preventDefault()); $('font-size-up').addEventListener('pointerdown', ev => ev.preventDefault()); $('text-bold').addEventListener('pointerdown', ev => ev.preventDefault()); $('text-italic').addEventListener('pointerdown', ev => ev.preventDefault()); $('emoji-insert-button').addEventListener('pointerdown', ev => ev.preventDefault());
  $('font-size-down').addEventListener('click', () => { applyTextFormat('fontSize', Number($('font-size-input').value || 22) - 2); if (app.inlineText) $('canvas-text-editor').focus({ preventScroll: true }); });
  $('font-size-up').addEventListener('click', () => { applyTextFormat('fontSize', Number($('font-size-input').value || 22) + 2); if (app.inlineText) $('canvas-text-editor').focus({ preventScroll: true }); });
  $('font-size-input').addEventListener('change', ev => { applyTextFormat('fontSize', ev.target.value); if (app.inlineText) $('canvas-text-editor').focus({ preventScroll: true }); });
  $('text-bold').addEventListener('click', () => { const current = app.inlineText || elementById(app.selectedId); applyTextFormat('fontWeight', current?.fontWeight === 'bold' ? 'normal' : 'bold'); });
  $('text-italic').addEventListener('click', () => { const current = app.inlineText || elementById(app.selectedId); applyTextFormat('fontStyle', current?.fontStyle === 'italic' ? 'normal' : 'italic'); });
  $('text-color-picker').addEventListener('input', ev => applyTextFormat('color', ev.target.value));
  $('emoji-insert-button')?.addEventListener('click', () => {
    // Toggle the picker; it is portalled to <body> so the text toolbar's horizontal
    // scrolling/transform cannot clip it or create nested scrollbars.
    if (typeof app.emojiPickerCleanup === 'function') { app.emojiPickerCleanup(); return; }
    const anchor = $('emoji-insert-button');
    const editor = $('canvas-text-editor');
    const picker = document.createElement('div');
    picker.className = 'emoji-picker-inline';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Emoji picker');
    const emojis = ['😀','😎','🤔','✨','🔥','❤️','👍','👎','🚀','🎯','💡','⚡','✅','❌','⚠️','📌','📦','🧠','📝','📈','📉','🔒','🔑','🌐','☁️','🗄️','🛠️','🤖','💻','📱','🔔','🎉','⭐','➡️','⬅️','⬆️','⬇️','🔄','⏱️','📊','🧩','🟢','🟡','🔴','🟣','🔵','⚙️','🧪','📁','🗂️','🧵','🔗','💬','👀','🙌','🤝','💭','🌱','🏁','🏆'];
    picker.innerHTML = emojis.map(e => `<button type="button" aria-label="Insert ${e}">${e}</button>`).join('');
    document.body.append(picker);

    const positionPicker = () => {
      if (!picker.isConnected || !anchor.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const p = picker.getBoundingClientRect();
      const margin = 8;
      // Align the popover near the emoji button, then clamp it inside the viewport.
      let left = r.right - p.width;
      left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin));
      let top = r.bottom + 7;
      if (top + p.height > window.innerHeight - margin) top = r.top - p.height - 7;
      top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin));
      picker.style.left = `${left}px`;
      picker.style.top = `${top}px`;
    };
    picker.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });

    const closePicker = () => {
      if (picker.isConnected) picker.remove();
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      document.removeEventListener('keydown', onPickerKeyDown, true);
      window.removeEventListener('resize', positionPicker);
      window.removeEventListener('scroll', positionPicker, true);
      if (app.emojiPickerCleanup === closePicker) app.emojiPickerCleanup = null;
    };
    const onOutsidePointerDown = ev => {
      if (!picker.contains(ev.target) && !anchor.contains(ev.target)) closePicker();
    };
    const onPickerKeyDown = ev => {
      if (ev.key === 'Escape') {
        ev.preventDefault(); ev.stopPropagation(); closePicker();
        if (app.inlineText) editor.focus({ preventScroll: true });
      }
    };
    app.emojiPickerCleanup = closePicker;
    // Do not use { once: true }: a click inside the popup must not consume this listener.
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onPickerKeyDown, true);
    window.addEventListener('resize', positionPicker);
    window.addEventListener('scroll', positionPicker, true);
    positionPicker();

    picker.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      if (!app.inlineText) { closePicker(); showToast('Start editing text on the canvas before inserting an emoji.'); return; }
      const start = editor.selectionStart ?? editor.value.length;
      const end = editor.selectionEnd ?? start;
      const emoji = btn.textContent;
      editor.setRangeText(emoji, start, end, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.focus({ preventScroll: true });
      closePicker();
    }));
  });
  $('inline-code-language').addEventListener('change', ev => applyTextFormat('language', ev.target.value));
  $('text-format-toolbar').addEventListener('focusout', () => { setTimeout(() => { if (app.inlineText && !$('text-format-toolbar').contains(document.activeElement) && document.activeElement !== $('canvas-text-editor')) finishInlineText(false); }, 0); });
  $('note-search').addEventListener('input', renderDashboard); $('dashboard-import').addEventListener('change', importAtDashboard); $('editor-import').addEventListener('change', importAtDashboard);
  $('document-title').addEventListener('input', e => { app.title = e.target.value; scheduleSave(); });
  document.querySelectorAll('[data-tool]').forEach(btn => btn.addEventListener('click', () => {
    $('tools-more-menu')?.classList.add('hidden'); $('tools-more-button')?.setAttribute('aria-expanded', 'false');
    if (btn.dataset.tool === 'image') { $('image-file').click(); return; }
    setTool(btn.dataset.tool);
  }));
  $('image-tool').addEventListener('click', () => $('image-file').click()); $('image-file').addEventListener('change', e => { addImageFile(e.target.files?.[0]); e.target.value = ''; });
  $('tool-other-shapes')?.addEventListener('click', () => openLibrary());
  $('tools-more-button').addEventListener('click', ev => {
    ev.preventDefault(); ev.stopPropagation();
    $('editor-more-menu').classList.add('hidden'); $('export-menu').classList.add('hidden');
    const menu = $('tools-more-menu'), opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening); $('tools-more-button').setAttribute('aria-expanded', String(opening));
  });
  $('tools-more-menu').addEventListener('click', ev => {
    if (!ev.target.closest('button')) return;
    setTimeout(() => { $('tools-more-menu').classList.add('hidden'); $('tools-more-button').setAttribute('aria-expanded', 'false'); }, 0);
  });
  $('tool-undo-menu').addEventListener('click', () => undo());
  $('tool-redo-menu').addEventListener('click', () => redo());
  $('add-frame')?.addEventListener('click', addFrame); $('add-code').addEventListener('click', createCodeBlockAtCenter); $('add-mermaid').addEventListener('click', openMermaidModal); $('open-library').addEventListener('click', openLibrary);
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo); $('zoom-out').addEventListener('click', () => zoomBy(.88)); $('zoom-in').addEventListener('click', () => zoomBy(1.14)); $('fit-canvas').addEventListener('click', fitCanvas);
  $('stroke-size').addEventListener('input', e => { app.size = Number(e.target.value); $('stroke-value').textContent = String(app.size); }); $('custom-color').addEventListener('input', e => { app.color = e.target.value; initColors(); });
  $('show-grid').addEventListener('change', e => { app.grid = e.target.checked; redraw(); }); $('clear-canvas').addEventListener('click', clearCanvas); $('save-library').addEventListener('click', saveSelectedToLibrary); $('manage-library').addEventListener('click', openSavedLibrary); $('join-from-home').addEventListener('click', showCollaborationModal); $('collab-button').addEventListener('click', () => app.roomId ? shareRoom() : showCollaborationModal());
  $('duplicate-object').addEventListener('click', duplicateSelected); $('delete-object').addEventListener('click', deleteSelected); $('send-back').addEventListener('click', () => app.selectedId && moveLayer(app.selectedId, -1)); $('bring-front').addEventListener('click', () => app.selectedId && moveLayer(app.selectedId, 1));
  $('selected-color').addEventListener('input', e => updateSelectedField('color', e.target.value)); $('selected-fill').addEventListener('change', e => updateSelectedField('fill', e.target.value)); $('selected-size').addEventListener('input', e => updateSelectedField('size', e.target.value)); $('selected-label').addEventListener('change', e => updateSelectedField('label', e.target.value));
  $('lock-object').addEventListener('change', e => updateSelectedField('locked', e.target.checked)); $('layer-sort').addEventListener('click', () => { snapshotHistory(); app.elements.reverse(); redraw(); renderLayerPanel(); scheduleSave(); broadcastScene(); });
  document.querySelectorAll('[data-inspector]').forEach(btn => btn.addEventListener('click', () => setInspectorTab(btn.dataset.inspector)));
  document.querySelectorAll('[data-quick]').forEach(btn => btn.addEventListener('click', () => addAtCenter(btn.dataset.quick)));
  $('export-menu-button').addEventListener('click', ev => { ev.stopPropagation(); $('tools-more-menu').classList.add('hidden'); $('tools-more-button').setAttribute('aria-expanded', 'false'); $('export-menu').classList.toggle('hidden'); $('editor-more-menu').classList.add('hidden'); });
  $('editor-more-button').addEventListener('click', ev => { ev.stopPropagation(); $('tools-more-menu').classList.add('hidden'); $('tools-more-button').setAttribute('aria-expanded', 'false'); $('editor-more-menu').classList.toggle('hidden'); $('export-menu').classList.add('hidden'); });
  $('more-import').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); $('editor-import').click(); });
  $('more-library').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); openLibrary(); });
  $('more-mermaid').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); openMermaidModal(); });
  $('more-code').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); createCodeBlockAtCenter(); });
  $('more-frame').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); addFrame(); });
  $('more-clear').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); clearCanvas(); });
  $('more-delete-canvas').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); deleteActiveCanvas(); });
  $('share-canvas-file').addEventListener('click', () => { $('editor-more-menu').classList.add('hidden'); shareCanvasFile(); });
  $('menu-show-grid').addEventListener('change', ev => { app.grid = ev.target.checked; $('show-grid').checked = app.grid; redraw(); });
  document.querySelectorAll('[data-export]').forEach(btn => btn.addEventListener('click', async () => { $('export-menu').classList.add('hidden'); if (btn.dataset.export === 'png') await exportPNG(); else if (btn.dataset.export === 'svg') exportSVG(); else if (btn.dataset.export === 'pdf') exportPDF(); else downloadProject(); }));
  document.addEventListener('click', ev => {
    if (!ev.target.closest('.menu-wrap')) $('export-menu').classList.add('hidden');
    if (!ev.target.closest('#editor-more-button') && !ev.target.closest('#editor-more-menu')) $('editor-more-menu').classList.add('hidden');
    if (!ev.target.closest('#selection-toolbar')) $('selection-more-menu').classList.add('hidden');
    if (!ev.target.closest('.tools-more-wrap')) { $('tools-more-menu').classList.add('hidden'); $('tools-more-button').setAttribute('aria-expanded', 'false'); }
  });
  // On trackpads, two-finger horizontal scroll often fires wheel events that browsers
  // can interpret as Back/Forward gestures. Capture and cancel them before browser navigation.
  window.addEventListener('wheel', ev => {
    if (app.view !== 'editor' || !ev.target.closest?.('#canvas-viewport, #drawing-canvas')) return;
    if (ev.target.closest?.('#canvas-text-editor, #text-format-toolbar, #selection-toolbar, .pop-menu, .inspector')) return;
    if (ev.cancelable) ev.preventDefault();
  }, { passive: false, capture: true });
  // Keep multi-touch gestures inside the editor while allowing normal touch editing in controls.
  viewport.addEventListener('touchstart', ev => { if (ev.touches.length > 1 && ev.cancelable) ev.preventDefault(); }, { passive: false });
  viewport.addEventListener('touchmove', ev => { if (ev.touches.length > 1 && ev.cancelable) ev.preventDefault(); }, { passive: false });
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerUp); viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('dragover', ev => { ev.preventDefault(); $('drop-overlay').classList.remove('hidden'); }); viewport.addEventListener('dragleave', ev => { if (!viewport.contains(ev.relatedTarget)) $('drop-overlay').classList.add('hidden'); });
  viewport.addEventListener('drop', ev => {
    ev.preventDefault(); $('drop-overlay').classList.add('hidden'); const pos = dropAt(ev), file = [...(ev.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
    if (file) addImageFile(file, pos); else { const text = ev.dataTransfer?.getData('text/plain'); if (text?.trim()) addElement({ id: uid(), type: 'text', x: pos.x, y: pos.y, text: text.slice(0, 5000), color: app.color, size: app.size, fontSize: 18, fontFamily: 'Excalifont', fontWeight: 'normal', fontStyle: 'normal', w: 280, h: 100 }); }
  });
  viewport.addEventListener('paste', ev => { const imageItem = [...(ev.clipboardData?.items || [])].find(item => item.type.startsWith('image/')); if (imageItem) { ev.preventDefault(); addImageFile(imageItem.getAsFile()); return; } const text = ev.clipboardData?.getData('text/plain'); if (text && app.view === 'editor' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { ev.preventDefault(); const r = viewport.getBoundingClientRect(); addElement({ id: uid(), type: 'text', x: (r.width / 2 - app.panX) / app.zoom, y: (r.height / 2 - app.panY) / app.zoom, text: text.slice(0, 5000), color: app.color, size: app.size, fontSize: 18, fontFamily: 'Excalifont', fontWeight: 'normal', fontStyle: 'normal', w: 260, h: 100 }); } });
  viewport.addEventListener('dblclick', ev => {
    if (Date.now() < suppressNativeDoubleClickUntil) return;
    if (ev.target.closest?.('.selection-toolbar, .text-format-toolbar, .pop-menu, .tools-overflow-menu, .inspector')) return;
    if (ev.target === $('canvas-text-editor')) return;
    // Use the canvas itself as the editor surface: the textarea is overlaid at the exact
    // world position and focused immediately. Text creation never opens a modal.
    ev.preventDefault();
    handleCanvasDoubleTap(ev);
  }, true);
  window.addEventListener('keydown', ev => {
    if (ev.code === 'Space' && app.view === 'editor' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { app.spaceHeld = true; updateCanvasCursor(); ev.preventDefault(); }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || app.view !== 'editor') return;
    const key = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
    if (app.canvasLocked && key !== 'escape' && !(mod && ['0', '+', '=', '-'].includes(key))) { ev.preventDefault(); return; }
    if (mod && key === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
    else if (mod && key === 'y') { ev.preventDefault(); redo(); }
    else if (mod && key === 's') { ev.preventDefault(); saveActive(); showToast('Canvas saved on this device.'); }
    else if (mod && key === 'd') { ev.preventDefault(); duplicateSelected(); }
    else if (mod && (key === 'b' || key === 'i') && app.selectedId) { const e = elementById(app.selectedId); if (e && (['text','code','sticky'].includes(e.type) || (['rect','ellipse','diamond'].includes(e.type) && e.text))) { ev.preventDefault(); snapshotHistory(); if (key === 'b') e.fontWeight = e.fontWeight === 'bold' ? 'normal' : 'bold'; else e.fontStyle = e.fontStyle === 'italic' ? 'normal' : 'italic'; redraw(); scheduleSave(); broadcastScene(); } }
    else if (key === 'enter' && app.selectedId) { ev.preventDefault(); editSelectedOnCanvas(); }
    else if (mod && key === '0') { ev.preventDefault(); fitCanvas(); }
    else if (mod && (key === '+' || key === '=')) { ev.preventDefault(); zoomBy(1.14); }
    else if (mod && key === '-') { ev.preventDefault(); zoomBy(.88); }
    else if (mod && key === 'a') { ev.preventDefault(); const ids = app.elements.filter(e => !e.hidden && !e.locked && e.type !== 'frame').map(e => e.id); if (ids.length) chooseSelectedKeepMany(ids[ids.length - 1], ids); else chooseSelected(null); }
    else if (mod && ev.shiftKey && key === 'n') { ev.preventDefault(); createNote(); }
    else if ((key === 'delete' || key === 'backspace') && app.selectedId) { ev.preventDefault(); deleteSelected(); }
    else if (['arrowleft','arrowright','arrowup','arrowdown'].includes(key) && app.selectedIds.length) { ev.preventDefault(); const step = ev.shiftKey ? 10 : 1; const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0; const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0; snapshotHistory(); const ids = new Set(app.selectedIds); app.elements = app.elements.map(e => ids.has(e.id) && !e.locked ? translateElement(e, dx, dy) : e); redraw(); renderLayerPanel(); scheduleSave(); broadcastScene(); }
    else if (key === 'escape') { chooseSelected(null); setTool('select'); }
    else if (!mod && key === '?') showShortcuts();
    else if (!mod && key === 'v') setTool('select'); else if (!mod && key === 'h') setTool('hand'); else if (!mod && key === 'p') setTool('pen'); else if (!mod && key === 'e') setTool('eraser'); else if (!mod && key === 'r') setTool('rect'); else if (!mod && key === 'o') setTool('ellipse'); else if (!mod && key === 'd') setTool('diamond'); else if (!mod && key === 'a') setTool('arrow'); else if (!mod && key === 'l') setTool('line'); else if (!mod && key === 't') setTool('text'); else if (!mod && key === 'n') setTool('sticky'); else if (!mod && key === 'i') $('image-file').click(); else if (!mod && key === 'f') setTool('frame'); else if (!mod && key === 'k') createCodeBlockAtCenter(); else if (!mod && key === 'm') openMermaidModal();
  });
  window.addEventListener('keyup', ev => { if (ev.code === 'Space') { app.spaceHeld = false; updateCanvasCursor(); } });
  window.addEventListener('resize', () => { resizeCanvas(); renderDashboard(); renderRemoteCursors(); });
  window.addEventListener('beforeunload', () => { if (app.activeId) saveActive(); if (app.ws) app.ws.close(); });
  window.addEventListener('storage', ev => { if (ev.key === 'ss-theme' && ev.newValue) setTheme(ev.newValue); });

  async function init() {
    document.documentElement.dataset.theme = app.theme; setTheme(app.theme); polishIcons();
    initColors(); await Promise.all([loadAllNotes(), loadLibrary()]); setTool('select'); updateHistoryButtons();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const params = new URLSearchParams(location.search);
    if (params.has('room')) setTimeout(showCollaborationModal, 400);
    const dbOk = await openDB().then(() => true).catch(() => false);
    if (!dbOk) setStatus('Local storage unavailable', 'error');
  }
  init();
})();
