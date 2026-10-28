import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pickPort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(25); }
  throw new Error('Timed out waiting for expected event.');
}
function listenMessages(ws) {
  const messages = [];
  ws.addEventListener('message', event => { try { messages.push(JSON.parse(event.data)); } catch {} });
  return messages;
}

test('web app static assets and health endpoint respond', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  for (const path of ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icons/sketchspace-192.png', '/assets/icon-catalog.js', '/assets/icon-catalog.json', '/assets/icons/png/aws.png', '/assets/icons/png/react.png', '/assets/icons/vector/aws.svg', '/assets/ui-icons.js', '/assets/eraser-cursor.svg']) {
    const response = await fetch(`${origin}${path}`); assert.equal(response.status, 200, `${path} should be served`);
  }
  const serviceWorker = await (await fetch(`${origin}/sw.js`)).text();
  assert.match(serviceWorker, /self\.addEventListener\('install'/, 'a real service worker should be installed');
  assert.match(serviceWorker, /catalog\.map\(item => item\.path\)/, 'transparent icon PNGs should be precached for offline use');
  assert.match(serviceWorker, /sketchspace-shell-v23-v1810-emoji-body-portal/, 'the service worker cache should use the current version');
  const health = await (await fetch(`${origin}/health`)).json();
  assert.equal(health.ok, true); assert.equal(typeof health.activeRooms, 'number');
  const rootResponse = await fetch(origin);
  assert.equal(rootResponse.headers.get('x-frame-options'), 'DENY');
  assert.match(rootResponse.headers.get('content-security-policy') || '', /default-src 'self'/);
  const head = await fetch(origin, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const malformed = await fetch(`${origin}/%ZZ`);
  assert.equal(malformed.status, 400, 'malformed path encoding should not crash the server');
});

test('icon library serves distinct transparent PNG assets rather than repeated placeholder shapes', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const catalogResponse = await fetch(`${origin}/assets/icon-catalog.json`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.ok(catalog.length >= 90, 'should include a substantial curated icon library');
  assert.equal(new Set(catalog.map(item => item.slug)).size, catalog.length, 'each icon should have a unique slug');
  assert.equal(new Set(catalog.map(item => item.path)).size, catalog.length, 'each icon should use a distinct image asset');
  assert.ok(catalog.every(item => item.path.endsWith('.png')));
  for (const item of catalog) {
    const pngResponse = await fetch(`${origin}${item.path}`);
    assert.equal(pngResponse.status, 200, `${item.path} should be served`);
    assert.match(pngResponse.headers.get('content-type') || '', /image\/png/);
    const png = Buffer.from(await pngResponse.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${item.path} must be a PNG file`);
    assert.equal(png[25], 6, `${item.path} should be RGBA with an alpha channel for transparency`);
  }
  const catalogJs = await (await fetch(`${origin}/assets/icon-catalog.js`)).text();
  assert.match(catalogJs, /window\.SKETCHSPACE_ICON_CATALOG/);
});

test('live rooms synchronize scenes and cursors without storing room IDs on the health endpoint', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const a = new WebSocket(`ws://127.0.0.1:${port}/ws`), b = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => { try { a.close(); b.close(); } catch {} });
  const ma = listenMessages(a), mb = listenMessages(b);
  await Promise.all([once(a, 'open'), once(b, 'open')]);
  const roomId = `test-${Date.now()}`;
  a.send(JSON.stringify({ type: 'join', roomId, name: 'Artist A', elements: [{ id: 'seed', type: 'rect', x: 1, y: 2, w: 30, h: 20 }] }));
  await waitFor(() => ma.find(m => m.type === 'room:state' && m.isNew));
  b.send(JSON.stringify({ type: 'join', roomId, name: 'Artist B', elements: [] }));
  await waitFor(() => mb.find(m => m.type === 'room:state' && !m.isNew && m.elements.length === 1));
  await waitFor(() => ma.find(m => m.type === 'room:members' && m.members.length === 2));
  a.send(JSON.stringify({ type: 'scene', elements: [{ id: 'message', type: 'text', text: 'live sync', x: 5, y: 5 }] }));
  await waitFor(() => mb.find(m => m.type === 'scene' && m.elements?.[0]?.text === 'live sync'));
  a.send(JSON.stringify({ type: 'cursor', point: { x: 17, y: 29 } }));
  await waitFor(() => mb.find(m => m.type === 'cursor' && m.name === 'Artist A' && m.point.x === 17));
  const health = await (await fetch(`${origin}/health`)).json();
  assert.equal(JSON.stringify(health).includes(roomId), false, 'public health response must not reveal room IDs');
});


test('editor exposes the compact toolbar, direct canvas text editor, contextual delete actions and shortcuts', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const html = await (await fetch(`${origin}/index.html`)).text();
  const js = await (await fetch(`${origin}/app.js`)).text();
  const css = await (await fetch(`${origin}/styles.css`)).text();
  assert.match(html, /id="canvas-text-editor"/, 'canvas should have an inline text editor');
  assert.match(html, /optgroup label="SketchSpace fonts"/, 'font menu uses SketchSpace branding');
  assert.match(html, /option value="Excalifont">SketchSpace · Hand-drawn<\/option>/, 'hand-drawn font is branded in the UI without changing its actual font family value');
  assert.doesNotMatch(html, /Import a SketchSpace or Excalidraw project|optgroup label="Excalidraw fonts"/, 'the UI should not show Excalidraw product branding');
  assert.match(html, /id="selection-toolbar"/, 'selected objects should have a contextual action bar');
  assert.match(html, /id="toggle-inspector"/, 'properties/layers panel should be toggleable');
  assert.match(js, /viewport\.addEventListener\('dblclick'/, 'double-click should be handled on the canvas viewport');
  assert.match(js, /startInlineText\(\{ x: p\.x, y: p\.y, text: '', fontSize: 22 \}\)/, 'empty canvas double-click should begin typing');
  assert.match(js, /data-selection-action/);
  assert.match(js, /showShortcuts/);
  assert.match(js, /window\.addEventListener\('wheel'/, 'trackpad wheel gestures should be captured');
  assert.match(js, /function reorderLayer/, 'layers should support drag-and-drop reordering');
  assert.match(js, /selected-path-style/, 'right-side properties should expose bent/curved line and arrow styles');
  assert.match(html, /id="path-style-quick"/, 'selected arrows/lines should expose quick routing controls beside object actions');
  assert.match(html, /data-path-style-quick="elbow"/, 'a bend/elbow route should be available as a one-click action');
  assert.match(html, /data-path-style-quick="curved"/, 'a curved route should be available as a one-click action');
  assert.match(js, /pathQuick\.querySelectorAll\('\[data-path-style-quick\]'\)/, 'quick path controls should reflect the selected line route');
  assert.match(js, /updateSelectedField\('pathStyle', button\.dataset\.pathStyleQuick\)/, 'quick path controls should update the selected arrow or line');
  assert.match(js, /function pathBendPoint\(e\)/, 'a selected line or arrow should expose an on-curve midpoint handle');
  assert.match(js, /function setCanvasLocked\(locked\)/, 'the new lock icon should toggle canvas editing while retaining pan/zoom');
  assert.match(html, /id="toggle-canvas-lock"[^>]*data-icon="lock"/, 'the first compact toolbar button should be the canvas lock control');
  assert.match((await (await fetch(`${origin}/assets/ui-icons.js`)).text()), /stroke-width=\\"1\.8\\"[\s\S]*M5 3l14 11/, 'bundled UI icons should use a thin hollow outline rather than filled glyphs');
  assert.match(js, /function pathQuadraticControl\(e\)/, 'dragging the visible midpoint should be converted into a quadratic curve control');
  assert.match(js, /if \(value !== 'curved'\) delete e\.bendPoint/, 'switching a manually bent path to straight or elbow should clear the custom curve');
  assert.match(js, /if \(app\.canvasLocked\) \{ showToast\('Canvas is locked/, 'double-click text editing should respect the canvas lock');
  assert.match(js, /pathHandleAt\(p, selected\)/, 'pointer-down on the visible endpoint/midpoint handles should start path editing');
  assert.match(js, /app\.drag\.mode === 'bend'[\s\S]*?bendPoint: \{ x: p\.x, y: p\.y \}/, 'dragging the midpoint should bend the line through that point');
  assert.match(js, /app\.drag\.mode === 'path-start'[\s\S]*?next\.w = p\.x - old\.x/, 'path endpoints should be draggable');
  assert.match(js, /c\.arc\(bend\.x, bend\.y, 5\.6 \/ app\.zoom/, 'the bend point should be visible while the path is selected');
  assert.match(js, /Math\.atan2\(y2 - control\.y, x2 - control\.x\)/, 'curved arrows should align their arrowhead to the final curve tangent');
  assert.match(js, /selected-path-style.*?addEventListener\('change', ev => updateSelectedField\('pathStyle'/s, 'line/arrow style should be editable from the right-side inspector');
  assert.match(js, /setTool\('frame'\)/, 'the frame shortcut should activate a drag-to-draw frame tool');
  assert.match(js, /ICONS\.emoji \|\| ICONS\['face-smile'\]/, 'the emoji picker should use a bundled vector icon');
  assert.match(js, /shape-label.*frame-label|frame-label.*shape-label/, 'shape and frame labels should edit in place');
  assert.match(js, /function shareCanvasFile/, 'the canvas should offer editable file sharing without a permanent notes backend');
  assert.match(html, /id="inline-font-family"/, 'font family should be available while editing on the canvas');
  assert.match(html, /id="font-size-up"/, 'font size controls should be available while editing on the canvas');
  assert.match(css, /overscroll-behavior-x:none/, 'horizontal browser navigation gestures should be contained over the canvas');
  assert.match(css, /\.tool-rail\{position:absolute;top:13px;left:50%/, 'tools should be arranged in a compact floating toolbar');
  assert.match(css, /\.inspector:not\(\.hidden\)\{left:auto;right:12px;top:58px;bottom:52px;width:264px/, 'on-demand properties/layers panel should open on the right');
  assert.match(css, /\.inspector\{top:42px;bottom:40px;left:auto;right:5px;width:235px/, 'responsive inspector should also stay on the right');
  assert.match(html, /id="tools-more-menu"/, 'secondary tools should be tucked into the overflow palette');
  assert.match(html, /class="back-home-glyph"/, 'editor navigation should use a single clean icon without overlapping brand text');
  assert.match(html, /class="menu-entry-icon"/, 'export menu entries should use consistent vector icons');
  assert.match(js, /function handleCanvasDoubleTap\(ev\)/, 'blank-canvas double click should start the inline text editor');
  assert.match(js, /function updateCanvasCursor\(ev\)/, 'the cursor should change based on hover and drag state');
  assert.match(js, /else if \(hovered\) cursor = 'move'/, 'hovering an element in selection mode should show a move cursor');
  assert.match(js, /app\.drag\?\.mode === 'move' \|\| app\.drag\?\.mode === 'pan'\) cursor = 'grabbing'/, 'dragging an object or canvas should show a grabbing cursor');
  assert.match(js, /function addElement\(e\) \{[\s\S]*?setTool\('select'\)/, 'programmatically creating an element should return to the selection tool');
  assert.match(js, /chooseSelected\(element\.id\);\s*if \(!\['stroke', 'eraser'\]\.includes\(element\.type\)\) setTool\('select'\);/, 'shape creation should return to select while pen and eraser stay active');
  assert.match(js, /if \(!\['stroke', 'eraser'\]\.includes\(element\.type\)\) setTool\('select'\)/, 'freehand drawing should remain active until manually changed');
  assert.match(js, /barHeight - 14/, 'the text-format toolbar should sit higher than the text being edited');
  assert.match(js, /viewport\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'trackpad gestures should be handled by the whole canvas viewport');
  assert.doesNotMatch(js, /canvas\.addEventListener\('wheel', onWheel/, 'wheel gestures should not be processed twice');
  assert.match(js, /app\.panX -= deltaX/, 'horizontal trackpad swipes should pan the canvas horizontally');
  assert.match(js, /app\.panY -= deltaY/, 'vertical trackpad swipes should pan the canvas vertically');
  const directTextHandler = js.match(/function handleCanvasDoubleTap\(ev\) \{([\s\S]*?)\n  function editSelectedOnCanvas/);
  assert.ok(directTextHandler, 'canvas double-click handler should exist');
  assert.doesNotMatch(directTextHandler[1], /openModal|prompt\(/, 'canvas double-click must not open a text-entry modal or prompt');
  assert.match(js, /app\.theme === 'dark' \? '#e6e6e6' : app\.color/, 'inline text should have enough contrast in both themes');
  assert.match(html, /id="undo" class="bottom-icon-button"/, 'undo and redo should live in the compact bottom controls');
  assert.match(html, /app\.js\?v=20261028-v1810-emoji-body-portal/, 'asset URLs should bust stale service-worker caches');
  assert.match(css, /\.editor-topbar\{position:absolute;z-index:42;top:0;left:0;right:0;height:0/, 'editor header should overlay the canvas and preserve vertical space');
  assert.doesNotMatch(js, /function openTextModal\(/, 'text editing must not use a modal');
  assert.doesNotMatch(js, /function openCodeModal\(/, 'code editing must stay on the canvas');
  assert.match(js, /async function deleteActiveCanvas\(/, 'the active canvas should be deletable from the editor menu');
  assert.match(js, /requestAnimationFrame\(\(\) => \{ redrawQueued = false; redraw\(\); \}\)/, 'high-frequency pointer updates should batch redraws');
  assert.match(js, /const pageSize = 48/, 'the real icon catalog should render in batches for responsiveness');
  assert.match(html, /assets\/icon-catalog\.js\?v=20261028-v1810-emoji-body-portal/, 'the transparent icon catalog should load before the app');
  assert.match(js, /const assetIconCatalog = Array\.isArray\(window\.SKETCHSPACE_ICON_CATALOG\)/, 'the app should use the curated transparent PNG catalog');
  assert.match(js, /data-catalog-category/, 'the icon library should offer category filters');
  assert.match(js, /async function iconAssetAsDataUrl\(/, 'inserted icon assets should be embedded into notes so exports remain portable');
  assert.doesNotMatch(js, /variantSuffixes|const systemConcepts/, 'the library should not manufacture duplicate placeholder variants');
  assert.match(html, /option value="Excalifont"/, 'the Excalidraw-style hand-drawn font should be available');
  assert.match(html, /option value="Virgil"/, 'the classic Excalidraw hand-drawn font should be available');
  assert.match(html, /option value="Comic Shanns"/, 'the Excalidraw code font should be available');
  assert.match(js, /const indexedShapeCatalog = shapeCatalog\.map/, 'shape search should pre-index catalog entries for faster filtering');
  assert.match(css, /\.color-swatch:hover\{transform:scale\(1\.12\)\}/, 'color swatches should be circular with subtle interaction');
  assert.match(css, /font-family:\"Comic Shanns\"/, 'Comic Shanns should load from the Excalidraw font asset');
  assert.match(css, /font-family:\"Cascadia Code\"/, 'Cascadia Code should load from the Excalidraw font asset');
  assert.match(css, /\.dashboard \.hero\{display:grid!important/, 'the illustrated dashboard hero should be visible');
  assert.match(js, /else if \(\(ev\.ctrlKey \|\| ev\.metaKey\) && ev\.key === 'Enter'\)/, 'Ctrl/Cmd+Enter should finish inline editing while Enter inserts new lines');
});


test('inline text editing avoids rendering duplicate canvas text and aligns text editor metrics', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const js = await (await fetch(`${origin}/app.js`)).text();
  const css = await (await fetch(`${origin}/styles.css`)).text();
  assert.match(js, /const activeEdit = app\.inlineText\?\.editId \? app\.inlineText : null/, 'redraw tracks the exact element under inline editing');
  const inlineStart = js.match(/function startInlineText\(data\) \{([\s\S]*?)\n  function updateInlineTextPosition/);
  assert.ok(inlineStart, 'inline editor entry function should exist');
  assert.match(inlineStart[1], /updateTextFormatToolbar\(\);[\s\S]*?redraw\(\);[\s\S]*?requestAnimationFrame/, 'the canvas redraws immediately when text editing begins, before the textarea gets focus');
  assert.match(js, /editedElement\?\.type === 'text'[\s\S]*?filter\(e => e\.id !== activeEdit\.editId\)/, 'the original canvas text is hidden while its textarea editor is visible');
  assert.match(js, /id !== activeEdit\?\.editId\) drawSelection/, 'the active text element selection outline is hidden during editing');
  assert.match(js, /const alignedInsetY = isText \? -s\.fontSize \* 0\.95 : insetY/, 'textarea glyph baseline is aligned with canvas text baseline');
  assert.match(js, /editor\.style\.overflowWrap = 'break-word'/, 'long words wrap consistently instead of overflowing under the live editor');
  assert.match(js, /editor\.style\.lineHeight = '1\.3'/, 'textarea line spacing matches the canvas text line-height');
  assert.match(css, /\.canvas-text-editor\{[\s\S]*?white-space:pre-wrap/, 'the inline editor preserves multiline text');
});

test('canvas background always switches to matching black/white default when UI theme changes', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const js = await (await fetch(`${origin}/app.js`)).text();
  const html = await (await fetch(`${origin}/index.html`)).text();
  const css = await (await fetch(`${origin}/styles.css`)).text();
  assert.match(js, /function defaultCanvasBackground\(\) \{ return app\.theme === 'dark' \? '#111111' : '#ffffff'; \}/);
  assert.match(js, /function canvasBackgroundModeFor\(note\)/, 'notes can distinguish theme-following vs explicit custom backgrounds');
  assert.match(js, /function canvasBackgroundForNote\(note\)/, 'dashboard previews and open notes resolve the active theme background');
  assert.match(js, /if \(changed\) \{\s*app\.canvasBackgroundMode = 'theme';\s*app\.canvasBackground = defaultCanvasBackground\(\)/, 'each actual theme switch resets the active canvas to dark or light paper');
  assert.match(js, /backgroundMode: app\.canvasBackgroundMode \|\| 'theme'/, 'background mode should be saved with local notes');
  assert.match(js, /app\.canvasBackgroundMode = 'custom'/, 'choosing a color should mark the background as explicitly custom');
  assert.match(js, /canvas-bg-follow-theme/, 'users can return a canvas to theme-following mode');
  assert.match(html, /id="canvas-bg-follow-theme"/, 'canvas background mode reset button should be present');
  assert.match(css, /\.canvas-bg-follow-theme\{[^}]*border-radius:50%/, 'background mode reset control should match circular canvas color controls');
});


test('collaboration modal is branded as SketchSpace and uses grouped, consistently spaced fields', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const html = await (await fetch(`${origin}/index.html`)).text();
  const js = await (await fetch(`${origin}/app.js`)).text();
  const css = await (await fetch(`${origin}/styles.css`)).text();
  assert.match(js, /eyebrow: 'SKETCHSPACE COLLABORATION'/, 'collaboration modal must show SketchSpace branding');
  assert.match(js, /className: 'collaboration-modal'/, 'collaboration modal receives its own layout class');
  assert.match(js, /class="collaboration-form"[\s\S]*?class="collaboration-field-group"[\s\S]*?id="collab-name"[\s\S]*?id="collab-room"[\s\S]*?collaboration-notice/, 'collaboration fields are grouped for consistent spacing');
  assert.match(css, /\.collaboration-form\{display:flex;flex-direction:column;gap:17px/, 'form fields use a consistent vertical rhythm');
  assert.match(css, /\.collaboration-field-group \.field\{height:44px;min-height:44px/, 'name and room inputs have a consistent height');
  assert.match(css, /\.collaboration-notice\{margin:0;padding:12px 13px/, 'privacy note spacing aligns with the fields');
  assert.match(css, /\.collaboration-modal \.modal-actions\{margin-top:22px/, 'actions have deliberate separation from the form');
});


test('theme changes force the active canvas to black/white defaults and persist the mode', async () => {
  const { readFile } = await import('node:fs/promises');
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /if \(changed\) \{\s*app\.canvasBackgroundMode = 'theme';\s*app\.canvasBackground = defaultCanvasBackground\(\)/);
  assert.match(js, /activeNote\.background = app\.canvasBackground; activeNote\.backgroundMode = 'theme'/);
  assert.match(js, /function defaultCanvasBackground\(\) \{ return app\.theme === 'dark' \? '#111111' : '#ffffff'; \}/);
});

test('collaboration modal waits for room state and closes only after copying invite link', async () => {
  const { readFile } = await import('node:fs/promises');
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(js, /canDismiss: \(\) => phase !== 'invite'/);
  assert.match(js, /onRoomState: \(msg, connectedRoomId\) =>/);
  assert.match(js, /submit\.textContent = 'Copy invite link'/);
  assert.match(js, /const copied = await copyText\(inviteLink\);[\s\S]*?if \(!copied\)[\s\S]*?return true;/);
  assert.match(js, /iconNode\.innerHTML = ICONS\.share \|\|/);
  assert.doesNotMatch(js.match(/function updateRoomUI\(\) \{([\s\S]*?)\n  function renderRemoteCursors/)[1], /button\.innerHTML =/, 'room updates should not rebuild the share button');
  assert.match(html, /id="collab-button"[\s\S]*?class="people-icon"/);
});

test('properties/layers panel has no cross button and closes through the existing toggle menu', async () => {
  const { readFile } = await import('node:fs/promises');
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="close-inspector"/, 'remove the extra X from the properties/layers panel');
  assert.doesNotMatch(js, /closeInspector|close-inspector/, 'there should be no redundant close button handler');
  assert.doesNotMatch(css, /\.inspector-close\{/, 'there should be no close button styles');
  assert.match(js, /function toggleInspector\(\)[\s\S]*?panel\.classList\.toggle\('hidden', !opening\)/, 'the panel remains toggleable from the More menu');
  assert.match(css, /\.inspector-tabs\{padding-right:0!important\}/, 'tabs use the full header width after removing the close button');
});

test('live collaboration share icon remains in place and uses a visible outline style', async () => {
  const { readFile } = await import('node:fs/promises');
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="collab-button"[\s\S]*?class="people-icon"[\s\S]*?class="collab-button-text"/);
  const updater = js.match(/function updateRoomUI\(\) \{([\s\S]*?)\n  function renderRemoteCursors/);
  assert.ok(updater, 'room UI updater should exist');
  assert.match(updater[1], /const iconNode = button\.querySelector\('\.people-icon'\)/, 'updater should retain the existing share icon node');
  assert.match(updater[1], /if \(iconNode && !iconNode\.querySelector\('svg'\)\)/, 'updater should restore the share icon only if it is missing');
  assert.match(updater[1], /labelNode\.textContent = label/, 'only the room status label should change when members update');
  assert.doesNotMatch(updater[1], /button\.innerHTML =/, 'member updates must not rebuild and drop the share icon');
  assert.match(css, /#collab-button \.people-icon svg\{[^}]*fill:none!important;stroke:currentColor!important/s, 'share icon should use visible stroke rather than being filled invisibly');
});


test('emoji picker is portalled outside the scrolling text toolbar and stays within the viewport', async t => {
  const port = await pickPort();
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } });
  const js = await (await fetch(`${origin}/app.js`)).text();
  const css = await (await fetch(`${origin}/styles.css`)).text();
  const html = await (await fetch(`${origin}/index.html`)).text();
  assert.match(js, /document\.body\.append\(picker\)/, 'emoji picker should be attached to body so toolbar overflow cannot clip it');
  assert.match(js, /const r = anchor\.getBoundingClientRect\(\)/, 'emoji picker should position from its trigger button');
  assert.match(js, /window\.innerWidth - p\.width - margin/, 'horizontal position must be clamped to viewport');
  assert.match(js, /window\.innerHeight - p\.height - margin/, 'vertical position must be clamped to viewport');
  assert.match(js, /document\.addEventListener\('pointerdown', onOutsidePointerDown, true\)/, 'outside click should close the picker reliably');
  assert.doesNotMatch(js, /document\.addEventListener\('pointerdown', function closeEmoji[\s\S]{0,260}\{once:true\}/, 'outside-click handler must not be consumed by the first click inside the picker');
  assert.ok(css.includes('position:fixed!important;z-index:10000;width:min(260px,calc(100vw - 16px))'), 'emoji popup should be fixed and sized for the viewport');
  assert.ok(css.includes('max-height:min(238px,calc(100dvh - 16px));overflow-x:hidden;overflow-y:auto'), 'emoji popup should fit the viewport and scroll only vertically');
  assert.match(js, /if \(typeof app\.emojiPickerCleanup === 'function'\) app\.emojiPickerCleanup\(\)/, 'finishing text editing should clean up an open emoji popup');
  assert.match(html, /id="emoji-insert-button"/, 'emoji insertion button should remain available');
});
