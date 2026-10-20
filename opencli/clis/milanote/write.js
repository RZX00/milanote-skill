import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  COMMENT_COLUMNS,
  LIST_COLUMNS,
  assertPersisted,
  buildUpdateData,
  checklistItems,
  childrenOf,
  defaultSketchSvg,
  newMeta,
  nextPosition,
  optionalText,
  parseChecked,
  parseKind,
  planAttachment,
  planComment,
  planCreate,
  planDelete,
  planDuplicate,
  planMove,
  planUpdate,
  requireColor,
  requireElementId,
  requireHttpUrl,
  requireText,
  sketchDrawing,
  sectionFor,
  toListRow,
} from './codec.js';
import {
  LINK_ARG,
  applyShareLink,
  confirmedElement,
  ensureSession,
  fetchElementPayload,
  loadComments,
  loadElement,
  resolveContainer,
  runCollab,
  uploadAttachment,
} from './session.js';
import { createNoteViaUi, deleteViaUi, moveViaUi, updateTextViaUi } from './ui.js';

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

function defineMilanoteCommand(options) {
  cli({
    site: 'milanote',
    domain: 'app.milanote.com',
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    ...options,
    args: [...(options.args || []), LINK_ARG],
    func: async (page, args) => options.func(page, await applyShareLink(page, args, { open: true })),
  });
}

function placement(args) {
  return {
    x: Number.isInteger(args.x) ? args.x : -1,
    y: Number.isInteger(args.y) ? args.y : -1,
    index: Number.isInteger(args.index) ? args.index : -1,
  };
}

const VIA_ARG = {
  name: 'via',
  default: 'auto',
  choices: ['auto', 'api', 'ui'],
  help: 'auto: send the change to Milanote, and redo it in the editor if Milanote drops it; api: send only; ui: editor only',
};

// Some boards drop the actions this adapter builds while accepting the same change
// made in the editor (2026-10-19). Only a read-back that shows the change missing
// counts as dropped. Refusals before sending (a different signed-in user, an
// editor that is not ready) are rethrown: redoing them in the editor would bypass
// that guard.
function droppedWrite(error) {
  return error instanceof CommandExecutionError
    && /did not (persist|delete|stick)|but Milanote stored/i.test(String(error.message));
}

function noFallback(error, what) {
  return new CommandExecutionError(
    `${error.message}. The editor fallback covers ${what}; make this change in the editor (see the milanote skill).`,
  );
}

async function owned(page, elementId) {
  const loaded = await fetchElementPayload(page, elementId);
  const element = loaded.elements.find((item) => item.id === elementId);
  if (!element) throw new EmptyResultError('milanote get', `${elementId} was not found`);
  if (!element.parentId) {
    if (element.elementType === 'BOARD' || element.elementType === 'DOCUMENT') return { element, board: element };
    throw new CommandExecutionError(`Milanote did not say which board contains ${elementId}`);
  }
  const resolved = await resolveContainer(page, element.parentId);
  return { element, board: resolved.board };
}

defineMilanoteCommand({
  name: 'create',
  access: 'write',
  description: 'Create a board, column, note, link, task, checklist, swatch, or image',
  example: 'opencli milanote create --type note --text "Ship the CLI" --parent <boardId> -f yaml',
  args: [
    { name: 'type', required: true, choices: ['board', 'column', 'note', 'card', 'link', 'task', 'todo', 'checklist', 'swatch', 'color', 'image', 'line', 'sketch', 'annotation', 'document', 'table', 'alias'], help: 'Element to create' },
    { name: 'parent', default: '', help: 'Parent board, column, or checklist. Defaults to the home board' },
    { name: 'title', default: '', help: 'Title for a board, column, checklist, link, or swatch' },
    { name: 'text', default: '', help: 'Note text, task text, board description, or checklist items (one per line)' },
    { name: 'url', default: '', help: 'http(s) URL for a link or image' },
    { name: 'color', default: '', help: 'Swatch color, for example #336699' },
    { name: 'caption', default: '', help: 'Image caption' },
    { name: 'x', type: 'int', default: -1, help: 'Canvas x. Omit both x and y to auto-place' },
    { name: 'y', type: 'int', default: -1, help: 'Canvas y. Omit both x and y to auto-place' },
    { name: 'target', default: '', help: 'Element id to alias when --type alias' },
    { name: 'svg', default: '', help: 'SVG markup stored inside a sketch. The element must include width, height, and a path' },
    VIA_ARG,
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const kind = parseKind(args.type);
    const via = args.via || 'auto';
    const title = optionalText(args.title, 'title', 500);
    const text = optionalText(args.text, 'text');
    const caption = optionalText(args.caption, 'caption', 2000);
    const url = args.url ? requireHttpUrl(args.url, kind === 'image' ? 'image url' : 'url') : '';
    const color = args.color ? requireColor(args.color) : '';
    if ((kind === 'board' || kind === 'column') && !title) throw new ArgumentError('--title is required');
    if ((kind === 'note' || kind === 'task') && !text) throw new ArgumentError('--text is required');
    if (kind === 'link' && !url) throw new ArgumentError('--url is required');
    if (kind === 'image' && !url) throw new ArgumentError('--url is required for an image');
    if (kind === 'swatch' && !color) throw new ArgumentError('--color is required');
    if (kind === 'document' && !title) throw new ArgumentError('--title is required for a document');
    if (kind === 'annotation' && !text) throw new ArgumentError('--text is required for an annotation');
    const target = kind === 'alias' ? requireElementId(args.target, 'target') : '';
    const svg = kind === 'sketch' && args.svg ? sketchDrawing(args.svg).svg : '';
    if (kind === 'alias' && !args.target) throw new ArgumentError('--target is required for an alias');
    const items = kind === 'checklist' ? checklistItems(text) : [];

    const session = await ensureSession(page);
    const parentId = args.parent ? requireElementId(args.parent, 'parent') : session.homeBoardId;
    const { container, board } = await resolveContainer(page, parentId);
    if (kind === 'column' && container.elementType !== 'BOARD' && container.elementType !== 'DOCUMENT') {
      throw new ArgumentError('a column can only be created on a board');
    }
    if (kind === 'board' && container.elementType !== 'BOARD' && container.elementType !== 'DOCUMENT') {
      throw new ArgumentError('a board can only be created on a board');
    }
    if (container.elementType === 'TASK_LIST' && kind !== 'task' && kind !== 'checklist') {
      throw new ArgumentError('only tasks can be created inside a checklist');
    }
    const section = sectionFor(container.elementType, kind);
    const loaded = await fetchElementPayload(page, container.id);
    const position = nextPosition(childrenOf(loaded.elements, container.id), section, placement(args), kind);
    const uiNote = (kind === 'note' || kind === 'card') && container.elementType === 'BOARD' && section === 'CANVAS';
    const viaEditor = async () => {
      const explicit = Number.isInteger(args.x) && args.x >= 0;
      const stored = await createNoteViaUi(page, { boardId: board.id, x: position.x, y: position.y, text, explicit });
      return [toListRow(stored, 0)];
    };
    if (via === 'ui') {
      if (!uiNote) throw new ArgumentError('--via ui creates notes on a board canvas only');
      return viaEditor();
    }
    const plan = planCreate(newMeta(session.userId), {
      kind,
      boardId: board.id,
      parentId: container.id,
      containerType: container.elementType,
      section,
      position,
      title: title || '',
      text: text || '',
      url,
      color,
      caption: caption || '',
      items,
      target,
      svg,
    });
    try {
      await runCollab(page, session.userId, plan.events);
      const rows = [];
      for (const record of plan.records) {
        const found = await confirmedElement(page, record.id);
        rows.push(toListRow(assertPersisted(found, record), 0));
      }
      return rows;
    } catch (error) {
      if (via !== 'auto' || !droppedWrite(error)) throw error;
      if (!uiNote) throw noFallback(error, 'notes on a board canvas');
      // Only a missing element is redone; one that exists with the wrong content
      // would become a duplicate. A late arrival is checked like the first read.
      if (!/did not persist/i.test(String(error.message))) throw error;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const late = await confirmedElement(page, plan.records[0].id);
        if (late && late.elementType !== 'SKELETON') return [toListRow(assertPersisted(late, plan.records[0]), 0)];
      }
      return viaEditor();
    }
  },
});

defineMilanoteCommand({
  name: 'update',
  access: 'write',
  description: 'Change an element title, text, URL, color, caption, or checked state',
  example: 'opencli milanote update <id> --text "New text" -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Element id' },
    { name: 'title', default: '', help: 'New title' },
    { name: 'text', default: '', help: 'New note text, task text, link description, or board description' },
    { name: 'url', default: '', help: 'New http(s) URL' },
    { name: 'color', default: '', help: 'New swatch color' },
    { name: 'caption', default: '', help: 'New image caption' },
    { name: 'checked', default: '', help: 'true or false for a task' },
    { name: 'svg', default: '', help: 'Replacement <svg> for a sketch. Include width, height, and a path' },
    VIA_ARG,
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const id = requireElementId(args.id, 'id');
    const via = args.via || 'auto';
    const fields = {
      title: optionalText(args.title, 'title', 500),
      text: optionalText(args.text, 'text'),
      url: args.url ? requireHttpUrl(args.url, 'url') : null,
      color: args.color ? requireColor(args.color) : null,
      caption: optionalText(args.caption, 'caption', 2000),
      checked: parseChecked(args.checked),
      svg: args.svg ? sketchDrawing(args.svg).svg : null,
    };
    const session = await ensureSession(page);
    const { element, board } = await owned(page, id);
    const data = buildUpdateData(element.elementType, fields);
    const onlyText = fields.text != null
      && [fields.title, fields.url, fields.color, fields.caption, fields.checked, fields.svg].every((value) => value == null);
    const uiText = element.elementType === 'CARD' && onlyText;
    const viaEditor = async () => [toListRow(await updateTextViaUi(page, { boardId: board.id, element, text: fields.text }), 0)];
    if (via === 'ui') {
      if (!uiText) throw new ArgumentError('--via ui changes the text of a note only');
      return viaEditor();
    }
    try {
      await runCollab(page, session.userId, planUpdate(newMeta(session.userId), {
        boardId: board.id,
        elementId: element.id,
        data,
      }));
      const found = await confirmedElement(page, element.id);
      const expect = { id: element.id, elementType: element.elementType };
      if (data.title != null || data.label != null) expect.title = data.title ?? data.label;
      if (data.description != null || data.caption != null) expect.text = data.description ?? data.caption;
      if (data.textContent != null) expect.text = fields.text;
      if (data.url != null) expect.url = data.url;
      if (data.color != null) expect.color = data.color;
      if (data.checked != null) expect.checked = data.checked;
      if (data.drawing?.svg) expect.text = data.drawing.svg;
      return [toListRow(assertPersisted(found, expect), 0)];
    } catch (error) {
      if (via !== 'auto' || !droppedWrite(error)) throw error;
      if (!uiText) throw noFallback(error, 'note text');
      return viaEditor();
    }
  },
});

defineMilanoteCommand({
  name: 'draw',
  access: 'write',
  description: 'Create a sketch that already contains an SVG stroke',
  example: 'opencli milanote draw --parent <boardId> -f yaml',
  args: [
    { name: 'parent', default: '', help: 'Board or column. Defaults to the home board' },
    { name: 'svg', default: '', help: 'SVG markup. Defaults to a horizontal line. Must include width, height, and a path' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const svg = sketchDrawing(args.svg || defaultSketchSvg()).svg;
    const session = await ensureSession(page);
    const parentId = args.parent ? requireElementId(args.parent, 'parent') : session.homeBoardId;
    const { container, board } = await resolveContainer(page, parentId);
    if (container.elementType === 'TASK_LIST') throw new ArgumentError('a sketch cannot be created inside a checklist');
    const section = sectionFor(container.elementType, 'sketch');
    const loaded = await fetchElementPayload(page, container.id);
    const position = nextPosition(childrenOf(loaded.elements, container.id), section, { x: -1, y: -1, index: -1 }, 'sketch');
    const plan = planCreate(newMeta(session.userId), {
      kind: 'sketch',
      boardId: board.id,
      parentId: container.id,
      containerType: container.elementType,
      section,
      position,
      title: '',
      text: '',
      url: '',
      color: '',
      caption: '',
      items: [],
      target: '',
      svg,
    });
    await runCollab(page, session.userId, plan.events);
    const rows = [];
    for (const record of plan.records) {
      const found = await confirmedElement(page, record.id);
      rows.push(toListRow(assertPersisted(found, record), 0));
    }
    return rows;
  },
});

defineMilanoteCommand({
  name: 'move',
  access: 'write',
  description: 'Move an element to another board or column, or change its position',
  example: 'opencli milanote move <id> --parent <columnId> -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Element id' },
    { name: 'parent', required: true, help: 'Destination board, column, or checklist' },
    { name: 'x', type: 'int', default: -1, help: 'Canvas x. Omit both x and y to auto-place' },
    { name: 'y', type: 'int', default: -1, help: 'Canvas y. Omit both x and y to auto-place' },
    { name: 'index', type: 'int', default: -1, help: 'Index inside a column or checklist' },
    VIA_ARG,
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const id = requireElementId(args.id, 'id');
    const via = args.via || 'auto';
    const parentId = requireElementId(args.parent, 'parent');
    if (id === parentId) throw new ArgumentError('an element cannot be moved into itself');
    const session = await ensureSession(page);
    if (id === session.homeBoardId) throw new ArgumentError('the home board cannot be moved');
    const { element } = await owned(page, id);
    const destination = await resolveContainer(page, parentId);
    const section = destination.container.elementType === 'COLUMN' || destination.container.elementType === 'TASK_LIST'
      ? 'INBOX'
      : 'CANVAS';
    const loaded = await fetchElementPayload(page, destination.container.id);
    const position = nextPosition(
      childrenOf(loaded.elements, destination.container.id).filter((item) => item.id !== id),
      section,
      placement(args),
      element.elementType,
    );
    // The editor fallback drags on one canvas: same board, canvas to canvas, not lines.
    const uiMove = section === 'CANVAS' && element.section === 'CANVAS' && element.parentId === destination.container.id
      && element.elementType !== 'LINE';
    const viaEditor = async () => [toListRow(await moveViaUi(page, {
      boardId: destination.board.id,
      element,
      x: position.x,
      y: position.y,
    }), 0)];
    if (via === 'ui') {
      if (!uiMove) throw new ArgumentError('--via ui moves an element within the canvas of its own board only');
      return viaEditor();
    }
    try {
      await runCollab(page, session.userId, planMove(newMeta(session.userId), {
        boardId: destination.board.id,
        elementId: element.id,
        parentId: destination.container.id,
        section,
        position,
      }));
      const found = assertPersisted(await confirmedElement(page, element.id), {
        id: element.id,
        parentId: destination.container.id,
      });
      // With an unchanged parent, only the coordinates show whether the move landed.
      if (section === 'CANVAS' && (found.x !== position.x || found.y !== position.y)) {
        throw new CommandExecutionError(`Move did not stick for ${element.id}`);
      }
      return [toListRow(found, 0)];
    } catch (error) {
      if (via !== 'auto' || !droppedWrite(error)) throw error;
      if (!uiMove) throw noFallback(error, 'moves within the canvas of one board');
      return viaEditor();
    }
  },
});

defineMilanoteCommand({
  name: 'delete',
  access: 'write',
  description: 'Delete one element. Requires --yes true and refuses the home board',
  example: 'opencli milanote delete <id> --yes true -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Element id' },
    { name: 'yes', type: 'boolean', default: false, help: 'Confirm permanent deletion of this element' },
    VIA_ARG,
  ],
  columns: ['id', 'elementType', 'deleted', 'childCount'],
  func: async (page, args) => {
    if (args.yes !== true) {
      throw new ArgumentError('delete requires --yes true', 'This permanently removes the element and anything inside it.');
    }
    const id = requireElementId(args.id, 'id');
    const via = args.via || 'auto';
    const session = await ensureSession(page);
    if (id === session.homeBoardId) throw new ArgumentError('the home board cannot be deleted');
    const { element, board } = await owned(page, id);
    const loaded = await fetchElementPayload(page, element.id);
    const childCount = childrenOf(loaded.elements, element.id).length;
    // A line has no body to grab, and a board without a parent is not drawn on any
    // canvas, so the editor fallback cannot drag either to Trash.
    const uiDelete = element.elementType !== 'LINE' && Boolean(element.parentId);
    const done = [{ id: element.id, elementType: element.elementType, deleted: true, childCount }];
    if (via === 'ui') {
      if (!uiDelete) throw new ArgumentError('--via ui cannot delete a line or a board that has no parent');
      await deleteViaUi(page, { boardId: board.id, element });
      return done;
    }
    try {
      await runCollab(page, session.userId, planDelete(newMeta(session.userId), { boardId: board.id, element }));
      let still = null;
      try {
        still = await confirmedElement(page, element.id);
      } catch (readError) {
        // A read of a deleted element can answer "<id> was deleted"; that is success.
        if (!/DELETED|not found/i.test(String(readError?.message || ''))) throw readError;
      }
      if (still && still.elementType !== 'SKELETON') {
        throw new CommandExecutionError(`Milanote did not delete ${element.id}`);
      }
      return done;
    } catch (error) {
      if (via !== 'auto' || !droppedWrite(error)) throw error;
      if (!uiDelete) throw noFallback(error, 'deletes of anything but lines and boards without a parent');
      await deleteViaUi(page, { boardId: board.id, element });
      return done;
    }
  },
});

defineMilanoteCommand({
  name: 'comment',
  access: 'write',
  description: 'Add a comment. Creates a comment thread on a board, or replies when --parent is a thread',
  example: 'opencli milanote comment --text "Looks good" --parent <boardId> -f yaml',
  args: [
    { name: 'text', required: true, help: 'Comment text. Supports **bold**, *italic*, ~~strike~~, `code`, and [label](https://...)' },
    { name: 'parent', default: '', help: 'Board, column, or existing comment thread. Defaults to the home board' },
  ],
  columns: COMMENT_COLUMNS,
  func: async (page, args) => {
    const text = requireText(args.text, 'text', 8000);
    const session = await ensureSession(page);
    const parentId = args.parent ? requireElementId(args.parent, 'parent') : session.homeBoardId;
    const parent = await loadElement(page, parentId);
    if (!parent) throw new EmptyResultError('milanote comment', `${parentId} was not found`);
    const meta = newMeta(session.userId);
    let plan;
    if (parent.elementType === 'COMMENT_THREAD') {
      const { board } = await owned(page, parent.id);
      plan = planComment(meta, { boardId: board.id, threadId: parent.id, text });
    } else {
      const { container, board } = await resolveContainer(page, parent.id);
      const section = sectionFor(container.elementType, 'note');
      const loaded = await fetchElementPayload(page, container.id);
      const position = nextPosition(childrenOf(loaded.elements, container.id), section, { x: -1, y: -1, index: -1 }, 'note');
      plan = planComment(meta, {
        boardId: board.id,
        parentId: container.id,
        section,
        position,
        text,
      });
    }
    await runCollab(page, session.userId, plan.events);
    if (plan.records.length) {
      const thread = await confirmedElement(page, plan.threadId);
      assertPersisted(thread, plan.records[0]);
    }
    const rows = await loadComments(page, plan.threadId);
    const match = rows.find((row) => row.text === text);
    if (!match) throw new CommandExecutionError(`Comment did not stick on ${plan.threadId}`);
    return [match];
  },
});

async function readUpload(filePath) {
  const raw = String(filePath ?? '').trim();
  if (!raw) throw new ArgumentError('--file is required');
  const resolved = path.resolve(raw);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ArgumentError(`file not found: ${resolved}`);
  }
  if (!info.isFile()) throw new ArgumentError('--file must be a file');
  if (info.size <= 0) throw new ArgumentError('--file is empty');
  if (info.size > MAX_UPLOAD_BYTES) throw new ArgumentError('--file must be <= 4MB');
  const bytes = await readFile(resolved);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  return {
    filename: path.basename(resolved),
    base64: bytes.toString('base64'),
    ext,
    contentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    fileType: IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file',
  };
}

defineMilanoteCommand({
  name: 'upload',
  access: 'write',
  description: 'Upload a local image or file onto a board (max 4MB)',
  example: 'opencli milanote upload --file ./cover.png --parent <boardId> -f yaml',
  args: [
    { name: 'file', required: true, help: 'Local file path' },
    { name: 'parent', default: '', help: 'Board or column. Defaults to the home board' },
    { name: 'caption', default: '', help: 'Optional image caption' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const upload = await readUpload(args.file);
    const caption = optionalText(args.caption, 'caption', 2000);
    const session = await ensureSession(page);
    const parentId = args.parent ? requireElementId(args.parent, 'parent') : session.homeBoardId;
    const { container, board } = await resolveContainer(page, parentId);
    const section = sectionFor(container.elementType, 'note');
    const loaded = await fetchElementPayload(page, container.id);
    const position = nextPosition(childrenOf(loaded.elements, container.id), section, { x: -1, y: -1, index: -1 }, upload.fileType);
    const plan = planAttachment(newMeta(session.userId), {
      boardId: board.id,
      parentId: container.id,
      section,
      position,
      fileType: upload.fileType,
      caption: caption || '',
    });
    await runCollab(page, session.userId, plan.events);
    const created = await confirmedElement(page, plan.id);
    assertPersisted(created, plan.records[0]);
    await uploadAttachment(page, {
      elementId: plan.id,
      filename: upload.filename,
      contentType: upload.contentType,
      fileType: upload.fileType,
      imageType: upload.fileType === 'image' ? 'original' : '',
      base64: upload.base64,
    });
    let stored = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      stored = await loadElement(page, plan.id, { missingOk: true });
      const ready = Boolean(stored?.url) || stored?.title === upload.filename;
      if (ready) break;
      await page.sleep(1);
      stored = null;
    }
    if (!stored) {
      throw new CommandExecutionError(
        `Milanote accepted ${plan.id} but the file was not attached. The empty card is still on the board.`,
      );
    }
    return [toListRow(stored, 0)];
  },
});

function rawElement(payload, id) {
  const bag = payload?.elements;
  if (!bag) return null;
  if (Array.isArray(bag)) return bag.find((item) => item?.id === id || item?._id === id) || null;
  return bag[id] || null;
}

function requireCellIndex(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new ArgumentError(`--${label} is required`);
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) throw new ArgumentError(`--${label} must be an integer >= 0`);
  if (index > 100) throw new ArgumentError(`--${label} must be <= 100`);
  return index;
}

defineMilanoteCommand({
  name: 'duplicate',
  access: 'write',
  description: 'Copy an element onto the same board, next to the original',
  example: 'opencli milanote duplicate <id> -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Element id to copy' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const id = requireElementId(args.id, 'id');
    const session = await ensureSession(page);
    if (id === session.homeBoardId) throw new ArgumentError('the home board cannot be duplicated');
    const loaded = await fetchElementPayload(page, id);
    const source = rawElement(loaded.payload, id);
    const element = loaded.elements.find((item) => item.id === id);
    if (!source || !element) throw new EmptyResultError('milanote duplicate', `${id} was not found`);
    const parentId = element.parentId;
    if (!parentId) throw new CommandExecutionError(`Milanote did not say which board contains ${id}`);
    const { board } = await resolveContainer(page, parentId);
    const siblings = childrenOf(loaded.elements, parentId);
    const section = element.section || 'CANVAS';
    const position = section === 'INBOX'
      ? nextPosition(siblings, section, { x: -1, y: -1, index: Number.isInteger(element.index) ? element.index + 1 : -1 })
      : nextPosition(siblings, section, { x: -1, y: -1, index: -1 }, element.elementType);
    const content = source.content && typeof source.content === 'object' ? source.content : {};
    const plan = planDuplicate(newMeta(session.userId), {
      boardId: board.id,
      parentId,
      section,
      position,
      elementType: element.elementType,
      content,
    });
    await runCollab(page, session.userId, plan.events);
    const copy = await confirmedElement(page, plan.id);
    assertPersisted(copy, plan.record);
    if (element.text && copy.text !== element.text) {
      throw new CommandExecutionError(`Duplicate ${plan.id} was created but its text did not match`);
    }
    return [toListRow(copy, 0)];
  },
});

defineMilanoteCommand({
  name: 'cell',
  access: 'write',
  description: 'Set one cell in a table. Row and column are zero-based',
  example: 'opencli milanote cell --id <tableId> --row 0 --col 0 --text "Name" -f yaml',
  args: [
    { name: 'id', required: true, help: 'Table element id' },
    { name: 'row', type: 'int', required: true, help: 'Zero-based row' },
    { name: 'col', type: 'int', required: true, help: 'Zero-based column' },
    { name: 'text', required: true, help: 'Cell text' },
  ],
  columns: ['id', 'row', 'col', 'text'],
  func: async (page, args) => {
    const id = requireElementId(args.id, 'id');
    const row = requireCellIndex(args.row, 'row');
    const col = requireCellIndex(args.col, 'col');
    const text = requireText(args.text, 'text', 2000);
    const session = await ensureSession(page);
    const loaded = await fetchElementPayload(page, id);
    const source = rawElement(loaded.payload, id);
    const element = loaded.elements.find((item) => item.id === id);
    if (!source || !element) throw new EmptyResultError('milanote cell', `${id} was not found`);
    if (element.elementType !== 'TABLE') throw new ArgumentError(`${id} is a ${element.elementType || 'element'}, not a table`);
    const tableContent = source.content?.tableContent;
    if (!tableContent || !Array.isArray(tableContent.data)) {
      throw new CommandExecutionError(`Table ${id} has no cell grid`);
    }
    if (row >= tableContent.data.length || !Array.isArray(tableContent.data[row]) || col >= tableContent.data[row].length) {
      throw new ArgumentError(`cell ${row},${col} is outside this table`);
    }
    const nextGrid = JSON.parse(JSON.stringify(tableContent));
    nextGrid.data[row][col] = { ...(nextGrid.data[row][col] || {}), value: text };
    const parentId = element.parentId;
    if (!parentId) throw new CommandExecutionError(`Milanote did not say which board contains ${id}`);
    const { board } = await resolveContainer(page, parentId);
    await runCollab(page, session.userId, planUpdate(newMeta(session.userId), {
      boardId: board.id,
      elementId: id,
      data: { tableContent: nextGrid },
    }));
    const after = await fetchElementPayload(page, id);
    const saved = rawElement(after.payload, id)?.content?.tableContent?.data?.[row]?.[col]?.value;
    if (saved !== text) throw new CommandExecutionError(`Cell ${row},${col} did not stick on ${id}`);
    return [{ id, row, col, text }];
  },
});
