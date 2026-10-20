## 2026-10-16 by cursor

Strategy: page-context session (`Strategy.COOKIE`).
Contract: internal, verified against a signed-in board on 2026-10-16, then the probe board was deleted.

Reads:
- `GET /api/users/me` for the user id and workspace root.
- `GET /api/boards?ids=<id>&excludeSelf=false&loadAncestors=false` for a board and its direct children. `includeChildren` on `/api/elements` does not return children.
- `GET /api/elements?ids=<id>&loadAncestors=false` when the boards payload does not contain that id.
- Note text is a TipTap document: `{ type: "doc", content: [{ type: "paragraph", attrs: { key, textAlign }, content: [{ type: "text", text }] }] }`.
- Image URLs are `content.image.original`.

Writes are dispatched through the open editor store. The live middleware emits them on the existing collab socket with the in-memory permission token. A separate Socket.IO client is ignored. `ELEMENT_UPDATE` patches are `updates: [{ id, changes }]`. Moves use `ELEMENT_MOVE` with a top-level `location`.

A REST readback is not success. The open editor must have the element in `state.elements` and must not list its id in `deletedElements`. Ids the adapter sends are 16 characters and start with `1` (ids the editor creates itself are 14). `creationSource` is `DOUBLE_CLICK`. `meta.versionId` is the first 11 characters of the element id plus `-1`. Other shapes are stored by the API and then hidden by the editor.

Verified live on 2026-10-16, then probe boards were deleted:
- Create: board, column, note, link, task, checklist, swatch, image URL, line, sketch, annotation, document, table, alias, comment thread.
- Upload: PNG and a text file via `POST /api/elements/attachments/presign`, then PUT. A file card is ready when `url` is set (Milanote may store a preview URL).
- Update: note and annotation `textContent`; document body is `content.description` (title and `textContent` updates are ignored). Task checked. Move via `ELEMENT_MOVE`.
- Note markdown round-trips: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[label](url)`.

`duplicate <id>` copies an element with `ELEMENT_CREATE` and the original content. `cell --id --row --col --text` writes a table cell by replacing `content.tableContent` and setting that cell's `value` to a string. Both were verified on 2026-10-16 and the probe board was deleted.

Sketch ink is `content.drawing = { paths: [], svg, width, height }`. Put it on `ELEMENT_CREATE` (`draw` or `create --type sketch --svg`). Replacing `drawing` on a sketch that already has an svg also sticks; writing `drawing` onto a sketch whose `drawing` is still null does not. Document titles and document `textContent` still cannot be changed after creation; document body updates go through `content.description`.

## 2026-10-19 by claude

Some boards reject adapter writes. On shared boards, and on at least one board under the home board, `create` fails with `did not persist` and `delete` fails with `did not delete`. Reads still work. Root cause not identified.

The editor UI still saves on those boards when driven with real input: double-click a blank canvas spot to create a note, then type; drag the toolbar Line onto the canvas, then drag each end onto a card to attach it. Injected `paste` or `dblclick` events are not a fallback: they break the skill's no-page-script rule and an auto-mode permission check blocks them.

`tree` takes the root as `--id <id>`. A positional id fails with `too many arguments`.

## 2026-10-19 by claude (editor fallback)

Rejection is intermittent and per board, not tied to sharing. The same board rejected adapter writes for minutes and later accepted them; "New Board" `1WYr8K16X0hF1i` failed every time for a while, then worked. During the failing windows, edits made in the editor on that board saved. Ruled out with probes on the day: whether the board is shared, which board the adapter tab shows, another client (same browser or another device) editing the board, clientTick reuse, element id format, and channel selection (the app's own permission functions return level 31 for every board tested). No error notice reaches the page state, and outgoing actions are not visible to page-level `WebSocket.send` or `fetch` hooks, so the server's reason stays unknown from the page.

What the app does differently from the adapter: it derives the element id from `app.clientData` (`clientId` plus a tick it then increments), sets a `transactionId`, leaves `meta.versionId` unset on create, and follows the create with a location action. The adapter's `user`, `sessionId` and `channels` are overwritten before sending: the identity middleware reads `app.clientData`, and the socket manager recomputes channels.

`create`, `update`, `move` and `delete` now take `--via auto|api|ui`. In `auto`, a dropped write is redone in the editor with trusted CDP input (`ui.js`): a double-click on a blank canvas spot makes a note, typing uses `Input.insertText` with Mod-B/I/Shift-S/E for marks, a drag moves an element or drops it on Trash. Page scripts only read geometry and set the canvas scroll.

Environment limits found while testing:
- A hidden page (its Chrome window minimized) takes no input: CDP input waits for a frame and times out after about 115 s. `document.visibilityState` is `hidden` then, so the fallback checks it and fails in about 5 s.
- A raw CDP `Page.captureScreenshot` hangs on a hidden tab; the bridge's `page.screenshot()` does not. The fallback uses the latter to force a frame.
- A CDP `mouseWheel` event can hang; the fallback scrolls the canvas by setting `scrollLeft`/`scrollTop` instead.
- `Emulation.setFocusEmulationEnabled` is not on the bridge's allowlist.
- With the display asleep, the first input after a pause takes about 5 s.
- A read of a just-deleted element can answer `BOARD_DELETED`; treat it as deleted.
- Dragging a column by its centre grabs the card inside it. Grab a column by its title bar.
