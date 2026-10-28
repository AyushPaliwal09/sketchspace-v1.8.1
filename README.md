# SketchSpace v1.8.0

**SketchSpace** is a local-first visual notes app with an infinite-feeling canvas, freehand handwriting, drawing tools, image drop/paste, reusable object libraries, layers, frames, code blocks, simple Mermaid flowchart import, export options, and name-only live collaboration rooms.

This version uses only Node.js built-in modules. There is no `npm install` step and no database dependency.

## Requirements

- Node.js 20 or newer (Node 22 recommended)
- A modern browser (Chrome, Edge, Firefox, Safari)

## Run locally

1. Extract this project folder.
2. Open a terminal inside the extracted `sketchspace` directory.
3. Start the app:

   ```bash
   npm start
   ```

   You can also run `node server.js` directly.
4. Open **http://localhost:3000**.
5. Run the project checks with `npm run check` and the HTTP/WebSocket smoke tests with `npm test`.

Health endpoint: `http://localhost:3000/health`.

## Deploy publicly

The app is designed to deploy as **one Node.js web service**. It needs Node.js 20+ and no third-party runtime packages. This is useful because the same HTTPS origin serves the frontend and the real-time WebSocket endpoint.

### Render / Railway / similar Node hosts

- Runtime: Node
- Build command: leave empty (no dependencies to install)
- Start command: `npm start`
- Set the service's port using the host's `PORT` environment variable (the host normally sets this automatically).
- Deploy the repository root, not the `public` subfolder.

After deployment, share the HTTPS site URL. Room invitations use the same origin and switch to secure WebSockets (`wss://`) automatically.

## Privacy and storage

- Personal canvases, object library entries, and theme preference are stored in **IndexedDB/localStorage in the visitor's browser**.
- Personal canvases are never uploaded to this server and there is no permanent notes database, account system, or cloud sync.
- Use Share on a note or Share canvas file to send an editable project file through your device share sheet where supported, otherwise download it. This is file sharing, not a hosted permanent note link. Export `.sketchspace.json` backups regularly. Clearing browser site data can remove locally saved canvases. To move them to another device, export the project and import it on that device.
- A shared room's live scene exists in server process memory only. It is removed when the room becomes empty or the server restarts. Each participant's edits are still auto-saved to that participant's own current local canvas.
- Collaboration is **name-only, not identity verification**. Anyone with the room link can join. Do not share sensitive content in public rooms. For a production public launch with unknown users, add room passwords/invite tokens, message limits, origin/rate restrictions, moderation and a stronger collaborative merge protocol.

## Features included

### Notes dashboard
- Create/open/rename/duplicate/delete notes
- Search by note title and text objects
- Preview cards and import projects
- Per-browser local persistence with autosave

### Transparent PNG icon library
- 96 distinct transparent PNG assets exported from existing Font Awesome Free SVG icons; no opaque background tiles and no fake 1,000-item repeated-shape variants.
- Categories include architecture, cloud, network, data, applications, runtime, DevOps, AI/ML, security, observability, messaging, product and diagramming.
- Search by name/category and filter by category. Inserted icons are embedded as data URLs in the drawing, so they remain available in saved notes and exported project files.
- The bundle includes Font Awesome Free solid icons and brand marks as separate SVG source files and transparent PNG assets. See `FONT-AWESOME-LICENSE.txt` for applicable licensing/attribution details.

### Drawing editor
- Mouse, touchscreen, and stylus freehand drawing through Pointer Events
- Eraser, rectangle, ellipse, diamond, arrow, line, text, sticky note, image, code block, and named frame tools
- Compact Excalidraw-inspired floating toolbar with consistent line icons, a small overflow menu for secondary tools, and quick zoom/undo/redo controls at the bottom
- Double-click / double-tap an empty canvas area to type directly at that point; double-click existing text, shape labels, arrow labels, frame titles, code blocks, or sticky notes to edit in place (Enter for a new line, Ctrl/Cmd+Enter to finish, Escape to cancel; text is edited in place without a text-entry modal)
- Contextual selection toolbar for duplicate, bring-forward and delete actions
- Select, move, resize (corner handle), duplicate and delete objects
- Per-object color/fill/stroke controls, names, lock and visibility toggles
- Actual layer stacking order controls with drag-and-drop reordering, plus bring forward/send backward
- Undo/redo, keyboard shortcuts, arrow-key nudging, mouse/touch/stylus drawing, two-finger pan/pinch zoom, trackpad pan/zoom, fit-to-drawing and dotted grid; horizontal canvas gestures are intercepted so the page does not accidentally navigate Back/Forward
- Properties/layers inspector is hidden by default and opens on the right on demand from the top-right More menu → Layers & objects; selected-object actions appear near the selection, with detailed actions under its three-dot menu
- Drag/drop images, clipboard image paste, and dropped text
- Custom and built-in reusable personal library
- Basic Mermaid flowchart import (`flowchart`/`graph`, common node shapes and arrow links)

### Export / import
- PNG export of drawing bounds
- SVG export with editable vector primitives (images embedded when data URLs are available)
- PDF via browser print dialog: choose “Save as PDF” in the print destination
- Editable `.sketchspace.json` export/import
- Best-effort import of simple Excalidraw JSON files. Some features and image references from Excalidraw may not map perfectly.

### Collaboration
- Enter a display name and create or join a room
- Copy/share room URL
- Live scene updates, participant list and cursor positions
- Local autosave remains on each participant's device; shared room state is ephemeral

### PWA / offline
- Installable manifest and shell caching service worker
- After the app has been opened online once, its cached shell can open offline. Personal notes remain available from the browser's local database. Real-time collaboration requires connectivity.

## Implementation notes and limitations

This is a self-contained diagram editor, not a byte-for-byte clone of the Excalidraw product. The Mermaid parser intentionally covers common simple flowcharts rather than the entire Mermaid language. The collaboration protocol sends scene snapshots; simultaneous edits can overwrite one another, particularly if two participants edit at the same time. It is suitable as a personal project starter, not a hardened multi-tenant production editor. PDF export uses the browser's print dialog rather than downloading a generated PDF silently. Rotation, grouping, complex text measurement, full Mermaid syntax, and robust conflict-free simultaneous editing are not implemented. Touch pinch/pan and trackpad canvas navigation are supported, but operating-system-level edge-swipe navigation can still vary by device/browser.

## Handy shortcuts

| Shortcut | Action |
|---|---|
| `V` | Select / move |
| `H` or hold `Space` | Pan |
| `P` | Pencil / handwriting |
| `E` | Eraser |
| `R` | Rectangle |
| `O` | Ellipse |
| `D` | Diamond |
| `A` | Arrow |
| `L` | Line |
| `T` | Text |
| `N` | Sticky note |
| `I` | Insert image |
| `F` | Add frame |
| `K` | Add code block |
| `M` | Import simple Mermaid flowchart |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` or `Ctrl/Cmd + Y` | Redo |
| `Ctrl/Cmd + D` | Duplicate selected object |
| `Delete` / `Backspace` | Delete selected object |
| `Ctrl/Cmd + S` | Save now |
| `Ctrl/Cmd + 0` | Fit drawing |
| `Ctrl/Cmd + =` / `-` | Zoom in / out |
| `Arrow keys` / `Shift + Arrow` | Nudge selection by 1 / 10 pixels |
| `?` | Show keyboard shortcuts |
| `Ctrl/Cmd + mouse wheel` | Zoom |
| `Esc` | Deselect |


### Cursor behavior and canvas navigation

- Shapes, arrows, text, images and one-shot insert actions return to the selection tool after creation. The pen/freehand and eraser tools stay active until you change tools manually.
- In selection mode, hovering over an unlocked object changes the cursor to a move cursor; hovering the bottom-right resize handle changes it to a diagonal resize cursor; active dragging uses a grabbing cursor.
- Trackpad two-finger scroll pans the infinite canvas horizontally and vertically. Ctrl/Cmd + wheel (normally a trackpad pinch gesture) zooms around the pointer.
- On touchscreen, a two-finger gesture pans and pinch-zooms the canvas. Native browser navigation gestures are contained over the drawing surface where the browser permits it.

To verify the interaction updates after extracting this archive, run `npm run check`, `npm test`, and `npm start`, then open `http://localhost:3000`. If this app was previously installed as a PWA, reload once so the new service-worker cache version activates.


## Version 1.4.0 updates
- Dashboard restored to the original spacious notes-card layout.
- Shortcut labels appear below primary toolbar icons.
- Handwriting-style font choices added (system fonts; availability varies by OS).
- Inline emoji picker added to canvas text formatting.
- Searchable icon library with 96 distinct transparent PNG assets converted from Font Awesome Free SVGs for architecture, network, data, runtime, AI/ML, security, observability and diagramming, plus basic editable shape primitives. Icons are individual image assets with transparent backgrounds; they are generic pictograms, not official vendor logos.
- Shape library has in-modal search to keep it usable.


## v1.5.0 polish

- Restored the original full hero dashboard (“Think it. Sketch it.”) and dark-first appearance for new users. Existing saved theme preference is preserved.
- Added an editor action to delete the active canvas from this device.
- Added Excalidraw-style font choices: Excalifont, Comic Shanns, Cascadia Code, Nunito and Lilita One, plus system handwriting fallbacks. Excalifont is loaded from the official Excalidraw font repository via jsDelivr; Nunito and Lilita One are loaded via Google Fonts, with system-font fallbacks if offline.
- Color inputs/swatch palette have circular swatches. The text formatting toolbar is positioned higher with additional clearance.
- Pen and eraser are persistent tools; shapes remain one-shot and return to the selection pointer. Text entry exits to the pointer when editing is finished.
- Reduced canvas work per frame by batching grid dots into one canvas path, caching element bounds for hit testing, batching high-frequency redraws through requestAnimationFrame, and rendering icon-library results in 48-item batches instead of constructing the entire catalog DOM at once.

### Font attribution

Excalifont is a font distributed by the Excalidraw project under the SIL Open Font License 1.1. SketchSpace loads its Latin font face remotely (not bundled) and uses local/system fallbacks if the network is unavailable. See the [official Excalidraw font directory](https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw/fonts).


### UI polish release (2026-10-27)

- Restored the original illustrated dark dashboard hero and canvas overview layout.
- Replaced the generated placeholder variants with a curated collection of 96 distinct transparent PNG icons, category filters and 48-item progressive rendering.
- Added all current Excalidraw font family names (Excalifont, Virgil, Nunito, Lilita One, Comic Shanns, Cascadia, Helvetica, Liberation Sans, Assistant) with browser/system fallbacks. Official family list: https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts
- Batched high-frequency redraws with `requestAnimationFrame` and optimized element bounds for large scenes.
- Text toolbar is positioned above text when space permits. Canvas deletion is available from the editor’s More menu.

Remote fonts require network access; matching local/system fallbacks are used if a web font is unavailable. Personal canvas storage remains local-first.


## v1.5.1 dashboard and performance polish

- Dashboard again uses the illustrated “Think it. Sketch it.” hero with the original dark workspace treatment.
- Font picker includes the complete current Excalidraw family names: Excalifont, Nunito, Lilita One, Comic Shanns, plus Virgil/Helvetica/Cascadia/Liberation Sans/Assistant compatibility options. The official family list is documented in the [Excalidraw constants](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts).
- Added online font-face declarations for Excalifont, Virgil, Comic Shanns and Cascadia, plus Nunito/Lilita One/Assistant from Google Fonts; fallback stacks remain available when offline.
- Shape library now uses a pre-indexed search catalog and progressively loads 72 results at a time, reducing initial DOM work.
- Continued batching animation-frame redraws and reducing temporary allocations in canvas rendering.
- Cache-busting asset version advanced to avoid stale UI assets after PWA updates.


### v1.6.0 — transparent PNG icon library
- Removed generated 1,000+ repeated rectangle/ellipse label variants from the library.
- Added 96 distinct transparent PNG assets derived from the bundled Font Awesome Free SVG icon and brand sets, with real alpha transparency, covering architecture, cloud, networking, runtime, DevOps, AI/ML, security, observability, messaging and diagramming.
- Added searchable category filters and image thumbnails; selecting a PNG inserts it as an image object with the PNG data embedded in the canvas for reliable local saving/export.
- Added static asset and PNG-alpha automated checks.


### v1.7.1 update
- VS Code-style charcoal theme and neutral blue accent.
- Local Font Awesome Free SVG UI icon set, including a visible emoji picker icon.
- Proper service-worker JavaScript with versioned shell caching and transparent icon-library pre-caching.
- Canvas background color control, right-side selection inspector, bent/curved connector settings, and responsive toolbar polish.


### v1.7.2 follow-up fixes
- Fixed the service worker file and cache version so it actually runs JavaScript and precaches the icon catalog for offline use.
- Aligned all asset query versions and PWA theme colors with the neutral VS Code-style charcoal palette.
- Bundled Font Awesome Free sun/moon and face-smile icons for theme and emoji controls.
- Corrected emoji fallback order so Canvas can find color emoji glyphs, and removed a CSS override that could ignore the selected font family while typing.
- Added a real drag-to-draw frame tool and exposed straight/elbow/curved connector style in the right properties panel.


### Current editor corrections
- The frame entry in the tool overflow is a click-drag tool; the More menu still provides a centered quick-insert frame.
- Selected lines/arrows expose straight, elbow/bent, or curved paths in the right-side Properties panel.
- Color emoji fallback font families are ordered ahead of generic families, and selected font families are respected by both canvas rendering and the inline text editor.
- Theme color and PWA install colors are now neutral charcoal / VS Code gray-blue rather than purple.


### v1.7.2 polish
- Bumped PWA cache version and asset query tokens to prevent stale UI from being reused.
- Added a drag-to-draw Frame tool in the tools overflow, while retaining quick-insert frames in the More menu.
- Added straight/elbow/curved path control to the right inspector for lines and arrows.
- Fixed Font Awesome sun/moon and emoji toolbar icon assets, emoji font fallback order, and selected font rendering while editing text.
- Updated PWA install colors to neutral charcoal.


### v1.7.5 — one-click arrow and line bends
- Added a contextual three-button route selector when a single arrow, line, or connector is selected: straight, elbow/bend, and curved. The active route is highlighted and updates immediately.
- Kept the existing route dropdowns in the right-side Properties panel and the More menu for the same styles.
- Fixed elbow-arrow rendering so the arrowhead aligns with the final horizontal segment in both canvas drawing and SVG export.
- Bumped the service-worker cache and static asset tokens so the UI update is picked up after reload.


### Editable line and arrow bend points (v1.7.5)

Select a line, arrow, or connector to reveal draggable start, on-curve midpoint, and end handles. Drag the midpoint to bend the curve through that point; drag either endpoint to reposition the connector end. The bend geometry is stored in the editable project and included in SVG exports.


### v1.7.5 — outline icons and on-canvas bend handles

- UI icons are bundled as local Lucide-style outline SVGs (stroke-based, no external CDN dependency); the shape library keeps its separate transparent PNG and vendor SVG assets.
- Toolbar controls use a consistent 16–18px hollow icon size with tiny right/bottom shortcut labels, matching the Excalidraw-inspired reference. Undo/redo and light/dark toggles use the same outline icon style.
- Added a functional canvas-editing lock toggle before the hand tool. Canvas panning and zooming still work while editing is locked.
- Line/arrow/connector selection shows start, on-curve midpoint, and end handles. Drag the midpoint to curve the path through that point; drag endpoints to reposition them.
- App remains a vanilla JS app; icons use the Lucide style that is commonly paired with shadcn/ui rather than React shadcn components, avoiding a risky frontend rewrite.


## v1.7.6 — Theme-aware canvas background

- The canvas background follows light/dark theme changes by default, including older notes that used a former default color.
- Notes remember whether their background follows the theme or was explicitly customized. Custom colors remain intact when switching the UI theme.
- Added a small theme-follow button beside the canvas background picker to return a custom canvas to theme-following mode.
- Dashboard previews and imported/exported editable project files respect the background mode.
- PWA cache version advanced to `sketchspace-shell-v17-theme-canvas`.

Run `npm run check`, `npm test`, and `npm start` to verify the app.


## v1.7.7 — Text editing overlap fix

- Canvas redraws immediately when inline editing starts, so the original text is suppressed before the transparent textarea receives focus; this removes the overlapping/doubled text.
- Canvas text is suppressed by edited element ID/type while the inline textarea is active, so a second copy is not painted underneath it.
- Active selection handles are hidden during inline editing for a cleaner text-editing view.
- Text editor baseline alignment, wrapping, spacing, and line-height are synchronized with canvas text rendering more closely.
- Browser cache version advanced to `sketchspace-shell-v18-text-edit`; asset query tokens were updated.


## v1.7.9 — Collaboration dialog polish

- Updated visible font menu branding to SketchSpace while preserving the underlying Excalifont font-family value for existing saved text.
- Removed the Excalidraw product name from the dashboard import tooltip; compatible project file extensions remain supported.
- Reworked the collaboration dialog with consistently grouped labels and inputs, aligned field heights, simpler privacy copy, and responsive spacing.
- Changed the dialog eyebrow to “SKETCHSPACE COLLABORATION”.
- Bumped the app asset and service-worker cache versions so previously installed copies can pick up the updated UI.


## v1.7.9 updates

- Theme toggle now always changes the active canvas background to near-black in dark mode and white in light mode, saving the active note's theme-following background mode.
- Collaboration creation/join stays open while connecting, then reveals a copy-invite-link step. The modal closes after copying succeeds; while the invite step is active, Escape/backdrop/cancel cannot dismiss it accidentally.
- Collaboration button uses a stable outline SVG icon across connected/disconnected states.
- Properties/Layers floating panel has an explicit × close button and resizes/redraws the canvas when closed.


## v1.7.9 follow-up fixes

- Theme switches force the current canvas to near-black in dark mode and white in light mode. A custom background is retained until the user switches the UI theme; switching themes then resets the canvas to the theme default.
- Collaboration now stays open after a room successfully connects, switches to an invite-link step, and closes after copying succeeds. On copy failure, the link remains selected and the dialog remains open.
- Collaboration button's outline SVG icon remains stable across connected/disconnected updates, and stays visible on mobile.
- Added a visible × button to close the floating Properties/Layers panel.


## v1.8.0 update

- Removed the extra X close button from the floating Properties/Layers panel; it remains openable and closable using the existing More → Layers & objects toggle.
- Kept the collaboration/share icon as a stable DOM node as the room and participant count change, rather than rebuilding the entire button every time.
- Explicitly restores the share icon if missing and applies outline SVG styling to the collaboration button so the share glyph remains visible when a room goes live.
- Advanced the static asset query version and service-worker cache version to avoid stale UI assets.


## v1.8.1 emoji picker fix

- Moved the emoji picker to a body-level fixed popover so the text formatter's horizontal scrolling and transforms no longer clip it or produce nested scrollbars.
- Anchors the popover to the emoji button, clamps it to viewport bounds, opens above when there is insufficient room below, and repositions it during viewport resize/scroll.
- Added a responsive grid, vertical-only scrolling, Escape-to-close and a reliable persistent outside-pointer handler.
- Emoji insertion preserves the text cursor/selection, inserts into the active inline editor, and returns focus to that editor.
