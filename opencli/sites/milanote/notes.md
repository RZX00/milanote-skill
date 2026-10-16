## 2026-10-16 by cursor

Strategy: page-context session (`Strategy.COOKIE`).
Contract: internal, verified against a signed-in board on 2026-10-16, then the probe board was deleted.

Reads:
- `GET /api/users/me` for the user id and workspace root.
- `GET /api/boards?ids=<id>&excludeSelf=false&loadAncestors=false` for a board and its direct children. `includeChildren` on `/api/elements` does not return children.
- `GET /api/elements?ids=<id>&loadAncestors=false` when the boards payload does not contain that id.
- Note text is a TipTap document: `{ type: "doc", content: [{ type: "paragraph", attrs: { key, textAlign }, content: [{ type: "text", text }] }] }`.
- Image URLs are `content.image.original`.

Writes are dispatched through the open editor store. The live middleware emits them on the existing collab socket with the in-memory permission token. A separate Socket.IO client is ignored. `ELEMENT_UPDATE` patches are `updates: [{ id, changes }]`. Moves use `ELEMENT_MOVE` with a top-level `location`. Success is reported only after a follow-up read.

Verified live on 2026-10-16, then probe boards were deleted:
- Create: board, column, note, link, task, checklist, swatch, image URL, line, sketch, annotation, document, table, alias, comment thread.
- Upload: PNG and a text file via `POST /api/elements/attachments/presign`, then PUT. A file card is ready when `url` is set (Milanote may store a preview URL).
- Update: note and annotation `textContent`; document body is `content.description` (title and `textContent` updates are ignored). Task checked. Move via `ELEMENT_MOVE`.
- Note markdown round-trips: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[label](url)`.

`duplicate <id>` copies an element with `ELEMENT_CREATE` and the original content. `cell --id --row --col --text` writes a table cell by replacing `content.tableContent` and setting that cell's `value` to a string. Both were verified on 2026-10-16 and the probe board was deleted.

Sketch ink is `content.drawing = { paths: [], svg, width, height }`. Put it on `ELEMENT_CREATE` (`draw` or `create --type sketch --svg`). Replacing `drawing` on a sketch that already has an svg also sticks; writing `drawing` onto a sketch whose `drawing` is still null does not. Document titles and document `textContent` still cannot be changed after creation; document body updates go through `content.description`.
