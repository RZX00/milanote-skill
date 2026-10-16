// Milanote element codec.
//
// Strategy: page-context session (OpenCLI Strategy.COOKIE).
// Contract: internal-unstable.
// Reads: GET /api/users/me and GET /api/elements?ids=&includeChildren=true
//   (also GET /api/boards/:id and GET /api/users/me/app-init/browser-extension).
// Writes: Socket.IO v4 on the collaboration host from window.__clientconf,
//   frames 42<n>["action", ELEMENT_CREATE|ELEMENT_UPDATE|ELEMENT_DELETE].
// Auth: the logged-in Chrome session only. This module never sees cookies.
// Public API: Milanote does not publish a content API. status.milanote.com is a status page.
// REST POST /api/elements is not the write path: cookie auth returns a null permission
// token for workspace roots. UI dragging is less stable than the collab frames the
// web app itself sends. Rich text is flattened to plain Draft.js blocks.

import { randomBytes } from 'node:crypto';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const USER_ID_RE = /^[a-f0-9]{24}$/i;
const ELEMENT_ID_RE = /^[A-Za-z0-9]{6,40}$/;

export const LIST_COLUMNS = [
  'depth', 'id', 'elementType', 'title', 'text', 'url', 'checked', 'color',
  'parentId', 'section', 'x', 'y', 'index', 'openUrl',
];

export const DETAIL_COLUMNS = [
  'id', 'elementType', 'title', 'text', 'url', 'checked', 'color',
  'parentId', 'section', 'x', 'y', 'index', 'createdTime', 'childCount', 'openUrl',
];

export const COMMENT_COLUMNS = ['id', 'threadId', 'parentId', 'text', 'createdAt'];

export const TYPE_CHOICES = [
  'board', 'column', 'note', 'card', 'link', 'task', 'todo',
  'checklist', 'swatch', 'color', 'image', 'line', 'sketch',
  'annotation', 'document', 'table', 'alias',
];

const TYPE_ALIAS = {
  board: 'board',
  column: 'column',
  note: 'note',
  card: 'note',
  link: 'link',
  task: 'task',
  todo: 'task',
  checklist: 'checklist',
  swatch: 'swatch',
  color: 'swatch',
  image: 'image',
  line: 'line',
  sketch: 'sketch',
  annotation: 'annotation',
  document: 'document',
  table: 'table',
  alias: 'alias',
};

const ELEMENT_TYPE = {
  board: 'BOARD',
  column: 'COLUMN',
  note: 'CARD',
  link: 'LINK',
  task: 'TASK',
  checklist: 'TASK_LIST',
  swatch: 'COLOR_SWATCH',
  image: 'IMAGE',
  line: 'LINE',
  sketch: 'SKETCH',
  annotation: 'ANNOTATION',
  document: 'DOCUMENT',
  table: 'TABLE',
  alias: 'ALIAS',
};

const CONTAINER_TYPES = new Set(['BOARD', 'DOCUMENT', 'COLUMN', 'TASK_LIST']);

export function isUserId(value) {
  return typeof value === 'string' && USER_ID_RE.test(value);
}

export function isElementId(value) {
  return typeof value === 'string' && ELEMENT_ID_RE.test(value) && !isUserId(value);
}

export function requireElementId(value, label = 'id') {
  const id = String(value ?? '').trim();
  if (!isElementId(id)) {
    throw new ArgumentError(`${label} must be a Milanote element id`);
  }
  return id;
}

export function requireLimit(value, fallback, max, label = 'limit') {
  const missing = value === undefined || value === null || value === '';
  const number = missing ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  if (number > max) throw new ArgumentError(`${label} must be <= ${max}`);
  return number;
}

export function requireDepth(value, fallback = 2) {
  const missing = value === undefined || value === null || value === '';
  const number = missing ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ArgumentError('depth must be an integer >= 0');
  }
  if (number > 6) throw new ArgumentError('depth must be <= 6');
  return number;
}

export function requireHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new ArgumentError(`${label} must be an http(s) URL. Local file upload is not available.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ArgumentError(`${label} must be an http(s) URL. Local file upload is not available.`);
  }
  return url.toString();
}

export function requireColor(value) {
  const hex = String(value ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new ArgumentError('color must be a 6-digit hex color like #336699');
  }
  return `#${hex.toUpperCase()}`;
}

export function optionalText(value, label, max = 20000) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (!text.trim()) return null;
  if (text.length > max) throw new ArgumentError(`${label} must be <= ${max} characters`);
  return text;
}

export function requireText(value, label, max = 20000) {
  const text = optionalText(value, label, max);
  if (text === null) throw new ArgumentError(`${label} is required`);
  return text;
}

export function parseKind(value) {
  const kind = TYPE_ALIAS[String(value ?? '').trim().toLowerCase()];
  if (!kind) {
    throw new ArgumentError(`type must be one of: ${TYPE_CHOICES.join(', ')}`);
  }
  return kind;
}

export function parseChecked(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  throw new ArgumentError('--checked must be true or false');
}

export function checklistItems(value) {
  const items = String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (items.length < 1) throw new ArgumentError('checklist --text needs one item per line');
  if (items.length > 30) throw new ArgumentError('checklist accepts at most 30 items per command');
  for (const item of items) {
    if (item.length > 2000) throw new ArgumentError('each checklist item must be <= 2000 characters');
  }
  return items;
}

export function generateElementId() {
  const bytes = randomBytes(15);
  let id = '1';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export function newMeta(userId) {
  if (!isUserId(userId)) throw new ArgumentError('Milanote user id is missing');
  const suffix = generateElementId();
  return {
    userId,
    now: Date.now(),
    sessionId: `msid-${suffix.slice(0, 10)}`,
    clientId: suffix.slice(0, 6),
    deviceId: `mdid-${suffix.slice(4, 14)}`,
  };
}

function copyMark(mark) {
  return mark.attrs ? { type: mark.type, attrs: { ...mark.attrs } } : { type: mark.type };
}

function toggleMark(marks, type) {
  const index = marks.findIndex((mark) => mark.type === type);
  if (index >= 0) marks.splice(index, 1);
  else marks.push({ type });
}

function parseInline(line) {
  const nodes = [];
  const marks = [];
  let text = '';
  let index = 0;
  const flush = () => {
    if (!text) return;
    const node = { type: 'text', text };
    if (marks.length) node.marks = marks.map(copyMark);
    nodes.push(node);
    text = '';
  };
  while (index < line.length) {
    if (line.startsWith('**', index)) {
      flush();
      toggleMark(marks, 'bold');
      index += 2;
      continue;
    }
    if (line.startsWith('~~', index)) {
      flush();
      toggleMark(marks, 'strike');
      index += 2;
      continue;
    }
    if (line[index] === '`') {
      flush();
      toggleMark(marks, 'code');
      index += 1;
      continue;
    }
    if (line[index] === '*' && line[index + 1] !== '*') {
      const italicOn = marks.some((mark) => mark.type === 'italic');
      const rest = line.slice(index + 1);
      const close = rest.indexOf('*');
      const opensWord = close > 0 && !/\s/.test(rest.slice(0, close));
      if (italicOn || opensWord) {
        flush();
        toggleMark(marks, 'italic');
        index += 1;
        continue;
      }
    }
    if (line[index] === '[') {
      const match = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(line.slice(index));
      if (match) {
        flush();
        const inner = parseInline(match[1]);
        for (const node of inner) {
          node.marks = [...(node.marks || []), { type: 'link', attrs: { href: match[2] } }];
          nodes.push(node);
        }
        index += match[0].length;
        continue;
      }
    }
    text += line[index];
    index += 1;
  }
  flush();
  return nodes;
}

function serializeMarks(text, marks) {
  const types = new Set((marks || []).map((mark) => mark.type));
  let out = text;
  if (types.has('code')) out = `\`${out}\``;
  if (types.has('italic')) out = `*${out}*`;
  if (types.has('bold')) out = `**${out}**`;
  if (types.has('strike')) out = `~~${out}~~`;
  const link = (marks || []).find((mark) => mark.type === 'link');
  if (link?.attrs?.href) out = `[${out}](${link.attrs.href})`;
  return out;
}

export function draftText(text) {
  return {
    type: 'doc',
    content: String(text).split('\n').map((line, index) => {
      const paragraph = {
        type: 'paragraph',
        attrs: { key: `l${index}`, textAlign: null },
      };
      const content = parseInline(line);
      if (content.length) paragraph.content = content;
      return paragraph;
    }),
  };
}

export function extractText(content) {
  if (!content || typeof content !== 'object') return '';
  const source = content.textContent ?? content.text;
  if (typeof source === 'string') return source;
  if (source && Array.isArray(source.blocks)) {
    return source.blocks.map((block) => block?.text ?? '').join('\n');
  }
  if (source && source.type === 'doc') return tiptapText(source).replace(/\n+$/, '');
  return '';
}

function tiptapText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(tiptapText).join('');
  if (node.type === 'text' && typeof node.text === 'string') return serializeMarks(node.text, node.marks);
  const inner = Array.isArray(node.content) ? node.content.map(tiptapText).join('') : '';
  if (node.type === 'paragraph' || node.type === 'heading') return `${inner}\n`;
  return inner;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeColorOut(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const hex = raw.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toUpperCase()}`;
  return raw;
}

export function openUrlFor(element) {
  if (!element || (element.elementType !== 'BOARD' && element.elementType !== 'DOCUMENT')) return '';
  return `https://app.milanote.com/${element.id}/`;
}

export function normalizeElement(key, raw) {
  const content = asObject(raw?.content) || {};
  const location = asObject(raw?.location) || {};
  const position = asObject(location.position) || {};
  const meta = asObject(raw?.meta) || {};
  const link = asObject(content.link) || {};
  const image = asObject(content.image) || {};
  const file = asObject(content.file) || {};
  const elementType = firstString(raw?.elementType);
  const title = firstString(content.title, link.title, content.label, file.filename, content.originalTitle);
  const drawing = asObject(content.drawing);
  const text = elementType === 'SKETCH' && typeof drawing?.svg === 'string' && drawing.svg
    ? drawing.svg
    : elementType === 'DOCUMENT' && typeof content.description === 'string' && content.description.trim()
      ? content.description
      : (extractText(content) || firstString(content.caption, content.description));
  return {
    id: firstString(raw?.id, raw?._id, key),
    elementType,
    title,
    text,
    url: firstString(
      content.url,
      link.url,
      content.src,
      typeof image.original === 'string' ? image.original : '',
      typeof image.regular === 'string' ? image.regular : '',
    ),
    parentId: firstString(location.parentId, raw?.parentId),
    section: firstString(location.section),
    x: finiteNumber(position.x),
    y: finiteNumber(position.y),
    index: Number.isInteger(position.index) ? position.index : null,
    checked: content.isComplete === true || content.checked === true,
    color: normalizeColorOut(content.color || content.hex || ''),
    createdTime: Number.isFinite(meta.createdTime) ? meta.createdTime : '',
  };
}

export function collectElements(payload) {
  const body = asObject(payload) || {};
  const data = asObject(body.data);
  const bags = [body.elements, data?.elements, body.boards, data?.boards].filter((bag) => bag != null);
  const out = [];
  const seen = new Set();
  for (const bag of bags) {
    const entries = Array.isArray(bag)
      ? bag.map((entry, index) => [firstString(entry?.id, entry?._id, String(index)), entry])
      : Object.entries(bag);
    for (const [key, raw] of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const element = normalizeElement(key, raw);
      if (!element.id || seen.has(element.id)) continue;
      seen.add(element.id);
      out.push(element);
    }
  }
  return out;
}

export function childrenOf(elements, parentId) {
  const others = elements.filter((element) => element.id !== parentId);
  const located = others.filter((element) => element.parentId === parentId);
  if (located.length > 0) return located;
  if (others.some((element) => element.parentId)) return [];
  return others;
}

export function byPosition(a, b) {
  const ay = a.y ?? Number.MAX_SAFE_INTEGER;
  const by = b.y ?? Number.MAX_SAFE_INTEGER;
  if (ay !== by) return ay - by;
  const ax = a.x ?? Number.MAX_SAFE_INTEGER;
  const bx = b.x ?? Number.MAX_SAFE_INTEGER;
  if (ax !== bx) return ax - bx;
  return (a.index ?? 0) - (b.index ?? 0);
}

export function toListRow(element, depth) {
  return {
    depth,
    id: element.id,
    elementType: element.elementType,
    title: element.title,
    text: element.text,
    url: element.url,
    checked: element.checked,
    color: element.color,
    parentId: element.parentId,
    section: element.section,
    x: element.x,
    y: element.y,
    index: element.index,
    openUrl: openUrlFor(element),
  };
}

export function toDetailRow(element, childCount) {
  return {
    id: element.id,
    elementType: element.elementType,
    title: element.title,
    text: element.text,
    url: element.url,
    checked: element.checked,
    color: element.color,
    parentId: element.parentId,
    section: element.section,
    x: element.x,
    y: element.y,
    index: element.index,
    createdTime: element.createdTime,
    childCount,
    openUrl: openUrlFor(element),
  };
}

function pickUser(body) {
  const sources = [body.user, body.currentUser, body.account, body.profile, body.me]
    .map(asObject)
    .filter(Boolean);
  for (const source of sources) {
    const userId = [source._id, source.id, source.userId].find(isUserId) || '';
    if (!userId) continue;
    return {
      userId,
      name: firstString(source.name, source.displayName, source.fullName),
      email: firstString(source.email),
    };
  }
  if (isUserId(body.userId) || (isUserId(body._id) && (body.email || body.name || body.displayName))) {
    const userId = isUserId(body.userId) ? body.userId : body._id;
    return {
      userId,
      name: firstString(body.name, body.displayName),
      email: firstString(body.email),
    };
  }
  return { userId: '', name: '', email: '' };
}

function explicitHomeId(body) {
  for (const key of ['homeBoardId', 'workspaceBoardId', 'rootBoardId', 'defaultBoardId']) {
    if (isElementId(body[key])) return body[key];
  }
  for (const source of [body.workspace, body.home, body.root].map(asObject).filter(Boolean)) {
    const id = source.id || source._id || source.boardId;
    if (isElementId(id)) return id;
  }
  return '';
}

export function pickHome(elements, explicitId = '') {
  if (explicitId) {
    const found = elements.find((element) => element.id === explicitId);
    return { homeBoardId: explicitId, homeTitle: found?.title || '' };
  }
  const containers = elements.filter((element) => element.elementType === 'DOCUMENT' || element.elementType === 'BOARD');
  if (containers.length === 0) return { homeBoardId: '', homeTitle: '' };
  const ids = new Set(elements.map((element) => element.id));
  const roots = containers.filter((element) => !element.parentId || !ids.has(element.parentId));
  const pool = roots.length ? roots : containers;
  const childScore = new Map(pool.map((element) => [element.id, 0]));
  for (const element of elements) {
    if (element.parentId && childScore.has(element.parentId)) {
      childScore.set(element.parentId, childScore.get(element.parentId) + 1);
    }
  }
  const ranked = [...pool].sort((a, b) => {
    const typeDelta = Number(b.elementType === 'DOCUMENT') - Number(a.elementType === 'DOCUMENT');
    if (typeDelta) return typeDelta;
    const titleDelta = Number(/^(home|workspace)$/i.test(b.title)) - Number(/^(home|workspace)$/i.test(a.title));
    if (titleDelta) return titleDelta;
    const scoreDelta = (childScore.get(b.id) || 0) - (childScore.get(a.id) || 0);
    if (scoreDelta) return scoreDelta;
    return a.id.localeCompare(b.id);
  });
  return { homeBoardId: ranked[0].id, homeTitle: ranked[0].title };
}

export function interpretMe(payload) {
  const body = asObject(payload) || {};
  const data = asObject(body.data) || {};
  const user = pickUser(body).userId ? pickUser(body) : pickUser(data);
  const elements = collectElements(body);
  const home = pickHome(elements, explicitHomeId(body) || explicitHomeId(data));
  return {
    topKeys: Object.keys(body),
    userId: user.userId,
    name: user.name,
    email: user.email,
    homeBoardId: home.homeBoardId,
    homeTitle: home.homeTitle,
    elements,
  };
}

export function payloadError(payload, id) {
  const errors = asObject(payload?.errors);
  const entry = errors ? asObject(errors[id]) : null;
  if (!entry) return '';
  return String(entry.error?.code || entry.code || 'ERROR');
}

export function collectComments(payload, elements) {
  const body = asObject(payload) || {};
  const data = asObject(body.data);
  const raw = asObject(body.comments) || asObject(data?.comments) || {};
  const threads = new Map(
    elements.filter((element) => element.elementType === 'COMMENT_THREAD').map((element) => [element.id, element]),
  );
  return Object.entries(raw).map(([key, value]) => {
    const item = asObject(value) || {};
    const threadId = firstString(item.threadId);
    const thread = threads.get(threadId);
    return {
      id: firstString(item._id, item.id, key),
      threadId,
      parentId: thread?.parentId || '',
      text: commentText(item),
      createdAt: item.createdAt ?? '',
    };
  }).filter((row) => row.id);
}

export function defaultSketchSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40"><path d="M 4 20 L 76 20" stroke="#323b4a" stroke-width="2" fill="none"/></svg>';
}

export function sketchDrawing(svg) {
  const markup = String(svg ?? '').trim();
  if (!markup.includes('<svg') || !markup.includes('<path')) {
    throw new ArgumentError('--svg must be an <svg> element that contains a <path>');
  }
  if (markup.length > 100000) throw new ArgumentError('--svg must be <= 100000 characters');
  const width = Number((markup.match(/\bwidth="(\d+(?:\.\d+)?)"/) || [])[1]);
  const height = Number((markup.match(/\bheight="(\d+(?:\.\d+)?)"/) || [])[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ArgumentError('--svg must include positive width and height attributes');
  }
  return { paths: [], svg: markup, width, height };
}

function defaultTableContent() {
  const rows = 4;
  const cols = 3;
  const width = 34;
  const colWidth = Math.round((width / cols) * 10) / 10;
  const colWidthsGU = Array.from({ length: cols }, (_, index) => (
    index === cols - 1 ? Math.round((width - (cols - 1) * colWidth) * 10) / 10 : colWidth
  ));
  const data = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, () => (
    row === 0
      ? { value: null, textStyle: ['BOLD'], background: 'TABLE_DEFAULT_HEADER_BACKGROUND_COLOR' }
      : { value: null }
  )));
  return { width, tableContent: { data, colWidthsGU } };
}

function commentText(item) {
  if (typeof item.text === 'string') return item.text;
  if (item.text?.type === 'doc') return extractText({ textContent: item.text });
  if (Array.isArray(item.text?.blocks)) return item.text.blocks.map((block) => block?.text || '').join('\n');
  if (typeof item.body === 'string') return item.body;
  return '';
}

export function isContainerType(elementType) {
  return CONTAINER_TYPES.has(elementType);
}

export function sectionFor(containerType, kind) {
  if (kind === 'task' || kind === 'checklist') {
    if (containerType === 'TASK_LIST') return 'INBOX';
  }
  if (containerType === 'COLUMN' || containerType === 'TASK_LIST') return 'INBOX';
  return 'CANVAS';
}

const FOOTPRINT = {
  COLUMN: [22, 40],
  BOARD: [18, 20],
  DOCUMENT: [18, 20],
  TABLE: [36, 32],
  SKETCH: [36, 24],
  LINE: [20, 20],
  TASK_LIST: [22, 30],
  IMAGE: [18, 16],
  FILE: [18, 16],
};

function sizeFor(kindOrType) {
  const type = kindOrType === 'file' ? 'FILE' : (ELEMENT_TYPE[kindOrType] || kindOrType || 'CARD');
  const pair = FOOTPRINT[type] || [18, 12];
  return { w: pair[0], h: pair[1] };
}

function canvasBoxes(siblings) {
  return siblings.filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y)).map((row) => {
    const size = sizeFor(row.elementType);
    return { x: row.x, y: row.y, ...size };
  });
}

function boxesHit(left, right) {
  const gap = 2;
  return left.x < right.x + right.w + gap
    && left.x + left.w + gap > right.x
    && left.y < right.y + right.h + gap
    && left.y + left.h + gap > right.y;
}

export function nextPosition(siblings, section, coords = {}, kind = '') {
  const x = coords.x ?? -1;
  const y = coords.y ?? -1;
  const index = coords.index ?? -1;
  if (section === 'INBOX') {
    if (!Number.isInteger(index)) throw new ArgumentError('index must be an integer');
    if (index > 10000) throw new ArgumentError('index must be <= 10000');
    const numbered = siblings.map((row) => row.index).filter((value) => Number.isInteger(value));
    const auto = numbered.length ? Math.max(...numbered) + 1 : siblings.length;
    const chosen = index >= 0 ? index : auto;
    return { index: chosen, score: chosen };
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new ArgumentError('x and y must be integers');
  if ((x >= 0) !== (y >= 0)) throw new ArgumentError('pass both --x and --y, or omit both to auto-place');
  if (x > 100000 || y > 100000) throw new ArgumentError('x and y must be <= 100000');
  const size = sizeFor(kind);
  const taken = canvasBoxes(siblings);
  const score = (siblings.length + 8) * 65536;
  if (x >= 0) {
    if (taken.some((box) => boxesHit({ x, y, ...size }, box))) {
      throw new ArgumentError(`position ${x},${y} overlaps an existing element`);
    }
    return { x, y, score };
  }
  for (let row = 0; row < 30; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const spot = { x: col * (size.w + 4), y: 4 + row * (size.h + 4), ...size };
      if (!taken.some((box) => boxesHit(spot, box))) return { x: spot.x, y: spot.y, score };
    }
  }
  throw new ArgumentError('no free canvas position; pass --x and --y');
}

function baseAction(meta, type, boardId, tick) {
  return {
    type,
    timestamp: meta.now,
    sync: true,
    user: { _id: meta.userId, clientId: meta.clientId, clientTick: tick },
    deviceId: meta.deviceId,
    sessionId: meta.sessionId,
    channels: [`${boardId}-LIVE`],
  };
}

export function navigateAction(meta, boardId, tick) {
  return {
    ...baseAction(meta, 'USER_NAVIGATE', boardId, tick),
    newBoardId: boardId,
    permissionId: null,
    permission: 31,
    persist: true,
    navigationSource: 'web',
    monitoring: { operation: 'GENERAL', requestMode: 'bufferFlush' },
    activity: { track: true, isPreviousBoardShared: false, isNewBoardShared: false },
  };
}

export function channelsPayload(userId, boardId) {
  return {
    joined: [userId, `${boardId}-LIVE`, `${userId}-PERSONAL`, boardId],
    left: [],
    bufferFlush: true,
    replay: true,
    monitoring: { requestMode: 'bufferFlush' },
  };
}

function elementMeta(meta, elementId) {
  const seed = String(elementId || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 11);
  return {
    creator: meta.userId,
    modifiedBy: meta.userId,
    createdTime: meta.now,
    modifiedTime: meta.now,
    platform: 'Desktop web',
    locationSectionModifiedTime: meta.now,
    versionId: `${seed}-1`,
  };
}

function createAction(meta, { id, elementType, parentId, section, position, content, boardId, tick }) {
  return {
    ...baseAction(meta, 'ELEMENT_CREATE', boardId, tick),
    id,
    elementType,
    location: { parentId, section, position },
    content,
    meta: elementMeta(meta, id),
  };
}

function updateAction(meta, { boardId, elementId, data, tick }) {
  return {
    ...baseAction(meta, 'ELEMENT_UPDATE', boardId, tick),
    updates: [{ id: elementId, changes: data }],
  };
}

function pushSession(events, meta, boardId) {
  events.push({ event: 'action', payload: navigateAction(meta, boardId, 1) });
  events.push({ event: 'update-channels', payload: channelsPayload(meta.userId, boardId) });
}

export function planCreate(meta, spec, nextId = generateElementId) {
  const events = [];
  pushSession(events, meta, spec.boardId);
  let tick = 2;
  const records = [];
  const add = (elementType, parentId, section, position, content, expect) => {
    const id = nextId();
    events.push({
      event: 'action',
      payload: createAction(meta, {
        id, elementType, parentId, section, position, content, boardId: spec.boardId, tick,
      }),
    });
    tick += 1;
    records.push({ id, elementType, ...expect });
    return id;
  };

  if (spec.kind === 'board') {
    add('BOARD', spec.parentId, spec.section, spec.position, {
      title: spec.title,
      ...(spec.text ? { description: spec.text } : {}),
    }, { title: spec.title, text: spec.text || '' });
    events.push({ event: 'sleep', ms: 2500 });
  } else if (spec.kind === 'column') {
    add('COLUMN', spec.parentId, spec.section, spec.position, { title: spec.title }, { title: spec.title });
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'note') {
    const textContent = draftText(spec.text);
    const id = add('CARD', spec.parentId, spec.section, spec.position, { textContent }, { text: spec.text });
    events.push({
      event: 'action',
      payload: updateAction(meta, { boardId: spec.boardId, elementId: id, data: { textContent }, tick }),
    });
    tick += 1;
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'link') {
    const content = {
      url: spec.url,
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.text ? { description: spec.text } : {}),
    };
    const id = add('LINK', spec.parentId, spec.section, spec.position, content, {
      url: spec.url,
      ...(spec.title ? { title: spec.title } : {}),
    });
    events.push({
      event: 'action',
      payload: updateAction(meta, { boardId: spec.boardId, elementId: id, data: content, tick }),
    });
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'swatch') {
    add('COLOR_SWATCH', spec.parentId, spec.section, spec.position, {
      color: spec.color,
      ...(spec.title ? { label: spec.title } : {}),
    }, { color: spec.color, ...(spec.title ? { title: spec.title } : {}) });
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'image') {
    add('IMAGE', spec.parentId, spec.section, spec.position, {
      url: spec.url,
      ...(spec.caption ? { caption: spec.caption } : {}),
    }, { url: spec.url, ...(spec.caption ? { text: spec.caption } : {}) });
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'line') {
    add('LINE', spec.parentId, spec.section, spec.position, {
      start: { x: 0, y: 17 },
      end: { x: 17, y: 0 },
      startStyle: 'NONE',
      endStyle: 'ARROW',
      lineStyle: 'SOLID',
      lineWeight: 2,
    }, {});
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'sketch') {
    const drawing = spec.svg ? sketchDrawing(spec.svg) : null;
    add('SKETCH', spec.parentId, spec.section, spec.position, {
      background: { color: 'WHITE' },
      width: 34,
      ...(drawing ? { drawing } : {}),
    }, drawing ? { text: drawing.svg } : {});
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'annotation') {
    add('ANNOTATION', spec.parentId, spec.section, spec.position, {
      transparent: { enabled: true },
      ...(spec.text ? { textContent: draftText(spec.text) } : {}),
    }, spec.text ? { text: spec.text } : {});
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'document') {
    add('DOCUMENT', spec.parentId, spec.section, spec.position, {
      title: spec.title,
      textContent: spec.text ? draftText(spec.text) : null,
      displayMode: 'ICON_VIEW',
      showMedia: false,
    }, { title: spec.title, ...(spec.text ? { text: spec.text } : {}) });
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'table') {
    add('TABLE', spec.parentId, spec.section, spec.position, defaultTableContent(), {});
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'alias') {
    add('ALIAS', spec.parentId, spec.section, spec.position, {
      linkTo: spec.target,
      linkAlias: true,
    }, {});
    events.push({ event: 'sleep', ms: 400 });
  } else if ((spec.kind === 'task' || spec.kind === 'checklist') && spec.containerType === 'TASK_LIST') {
    const items = spec.kind === 'checklist' ? spec.items : [spec.text];
    const start = spec.position.index ?? 0;
    items.forEach((item, offset) => {
      const textContent = draftText(item);
      const taskId = add('TASK', spec.parentId, 'INBOX', {
        index: start + offset,
        score: start + offset,
      }, { textContent, checked: false, isComplete: false }, { text: item });
      events.push({
        event: 'action',
        payload: updateAction(meta, {
          boardId: spec.boardId,
          elementId: taskId,
          data: { textContent, checked: false, isComplete: false },
          tick,
        }),
      });
      tick += 1;
    });
    events.push({ event: 'sleep', ms: 400 });
  } else if (spec.kind === 'task' || spec.kind === 'checklist') {
    const items = spec.kind === 'checklist' ? spec.items : [spec.text];
    const listTitle = spec.title || (spec.kind === 'task' ? 'Tasks' : '');
    const listId = add('TASK_LIST', spec.parentId, spec.section, spec.position, {
      title: listTitle || null,
      showTitle: Boolean(listTitle),
    }, listTitle ? { title: listTitle } : {});
    events.push({ event: 'sleep', ms: 250 });
    items.forEach((item, itemIndex) => {
      const textContent = draftText(item);
      const taskId = add('TASK', listId, 'INBOX', { index: itemIndex, score: itemIndex }, {
        textContent, checked: false, isComplete: false,
      }, { text: item });
      events.push({
        event: 'action',
        payload: updateAction(meta, {
          boardId: spec.boardId,
          elementId: taskId,
          data: { textContent, checked: false, isComplete: false },
          tick,
        }),
      });
      tick += 1;
    });
    events.push({ event: 'sleep', ms: 500 });
  } else {
    throw new ArgumentError(`unsupported create type ${spec.kind || ''}`);
  }

  return { records, events, elementType: ELEMENT_TYPE[spec.kind] };
}

export function buildUpdateData(elementType, fields) {
  const data = {};
  if (elementType === 'BOARD') {
    if (fields.title != null) data.title = fields.title;
    if (fields.text != null) data.description = fields.text;
  } else if (elementType === 'SKETCH') {
    if (fields.text != null) throw new ArgumentError('sketches use --svg, not --text');
    if (fields.svg != null) data.drawing = sketchDrawing(fields.svg);
  } else if (elementType === 'DOCUMENT') {
    if (fields.title != null) {
      throw new ArgumentError('a document title can only be set when the document is created');
    }
    if (fields.text != null) data.description = fields.text;
  } else if (elementType === 'COLUMN') {
    if (fields.text != null) throw new ArgumentError('columns use --title, not --text');
    if (fields.title != null) data.title = fields.title;
  } else if (elementType === 'CARD' || elementType === 'ANNOTATION') {
    if (fields.title != null) throw new ArgumentError('notes and annotations use --text, not --title');
    if (fields.text != null) data.textContent = draftText(fields.text);
  } else if (elementType === 'TASK') {
    if (fields.text != null) data.textContent = draftText(fields.text);
    if (fields.checked != null) {
      data.checked = fields.checked;
      data.isComplete = fields.checked;
    }
  } else if (elementType === 'LINK') {
    if (fields.url != null) data.url = fields.url;
    if (fields.title != null) data.title = fields.title;
    if (fields.text != null) data.description = fields.text;
  } else if (elementType === 'COLOR_SWATCH') {
    if (fields.color != null) data.color = fields.color;
    if (fields.title != null) data.label = fields.title;
  } else if (elementType === 'IMAGE') {
    if (fields.url != null) data.url = fields.url;
    if (fields.caption != null) data.caption = fields.caption;
  } else if (elementType === 'TASK_LIST') {
    if (fields.title != null) {
      data.title = fields.title;
      data.showTitle = Boolean(fields.title);
    }
  } else {
    throw new ArgumentError(`update does not support ${elementType || 'this element'} yet`);
  }
  if (Object.keys(data).length === 0) throw new ArgumentError('pass at least one field to change');
  return data;
}

export function planComment(meta, spec, nextId = generateElementId) {
  const events = [];
  pushSession(events, meta, spec.boardId);
  let threadId = spec.threadId || '';
  const records = [];
  if (!threadId) {
    threadId = nextId();
    events.push({
      event: 'action',
      payload: createAction(meta, {
        id: threadId,
        elementType: 'COMMENT_THREAD',
        parentId: spec.parentId,
        section: spec.section,
        position: spec.position,
        content: { threadId },
        boardId: spec.boardId,
        tick: 2,
      }),
    });
    records.push({ id: threadId, elementType: 'COMMENT_THREAD' });
  }
  const commentId = `Comment${nextId()}`;
  events.push({
    event: 'action',
    payload: {
      _id: commentId,
      type: 'COMMENTS_ADD',
      createdAt: meta.now,
      elementId: threadId,
      threadId,
      text: draftText(spec.text),
      transactionId: nextId(),
      sync: true,
    },
  });
  events.push({ event: 'sleep', ms: 500 });
  return { threadId, commentId, events, records };
}

export function planAttachment(meta, spec, nextId = generateElementId) {
  const id = nextId();
  const elementType = spec.fileType === 'image' ? 'IMAGE' : 'FILE';
  const events = [];
  pushSession(events, meta, spec.boardId);
  events.push({
    event: 'action',
    payload: createAction(meta, {
      id,
      elementType,
      parentId: spec.parentId,
      section: spec.section,
      position: spec.position,
      content: spec.caption ? { caption: spec.caption } : {},
      boardId: spec.boardId,
      tick: 2,
    }),
  });
  events.push({ event: 'sleep', ms: 400 });
  return { id, elementType, events, records: [{ id, elementType }] };
}

export function planDuplicate(meta, spec, nextId = generateElementId) {
  const id = nextId();
  const content = spec.elementType === 'COMMENT_THREAD'
    ? { ...(spec.content || {}), threadId: id }
    : (spec.content || {});
  const events = [];
  pushSession(events, meta, spec.boardId);
  events.push({
    event: 'action',
    payload: createAction(meta, {
      id,
      elementType: spec.elementType,
      parentId: spec.parentId,
      section: spec.section,
      position: spec.position,
      content,
      boardId: spec.boardId,
      tick: 2,
    }),
  });
  events.push({ event: 'sleep', ms: 500 });
  return { id, events, record: { id, elementType: spec.elementType } };
}

export function planUpdate(meta, { boardId, elementId, data }) {
  const events = [];
  pushSession(events, meta, boardId);
  events.push({ event: 'action', payload: updateAction(meta, { boardId, elementId, data, tick: 2 }) });
  events.push({ event: 'sleep', ms: 400 });
  return events;
}

export function planDelete(meta, { boardId, element }) {
  const events = [];
  pushSession(events, meta, boardId);
  events.push({
    event: 'action',
    payload: {
      ...baseAction(meta, 'ELEMENT_DELETE', boardId, 2),
      id: element.id,
      location: { parentId: element.parentId || boardId },
      elementType: element.elementType,
      tokens: [],
      activity: {
        track: false,
        boardId,
        elementTypes: { [element.id]: element.elementType },
      },
    },
  });
  events.push({ event: 'sleep', ms: 500 });
  return events;
}

export function planMove(meta, { boardId, elementId, parentId, section, position }) {
  const events = [];
  pushSession(events, meta, boardId);
  events.push({
    event: 'action',
    payload: {
      ...baseAction(meta, 'ELEMENT_MOVE', boardId, 2),
      id: elementId,
      location: { parentId, section, position },
    },
  });
  events.push({ event: 'sleep', ms: 400 });
  return events;
}

export function sameUrl(left, right) {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

export function assertPersisted(found, expect) {
  if (!found || found.elementType === 'SKELETON') {
    throw new CommandExecutionError(`Milanote did not persist ${expect.id}`);
  }
  if (expect.elementType && found.elementType !== expect.elementType) {
    throw new CommandExecutionError(
      `Expected ${expect.elementType} but Milanote stored ${found.elementType} for ${found.id}`,
    );
  }
  if (expect.title != null && found.title !== expect.title) {
    throw new CommandExecutionError(`Title did not stick for ${found.id}`);
  }
  if (expect.text != null && found.text !== expect.text) {
    throw new CommandExecutionError(`Text did not stick for ${found.id}`);
  }
  if (expect.url != null && !sameUrl(found.url, expect.url)) {
    throw new CommandExecutionError(`URL did not stick for ${found.id}`);
  }
  if (expect.color != null && normalizeColorOut(found.color) !== normalizeColorOut(expect.color)) {
    throw new CommandExecutionError(`Color did not stick for ${found.id}`);
  }
  if (expect.checked != null && found.checked !== expect.checked) {
    throw new CommandExecutionError(`Checked state did not stick for ${found.id}`);
  }
  if (expect.parentId != null && found.parentId !== expect.parentId) {
    throw new CommandExecutionError(`Move did not stick for ${found.id}`);
  }
  return found;
}

export function redact(value) {
  return String(value ?? '')
    .replace(/cookie\s*[:=][^\s,;]*/gi, 'cookie=[redacted]')
    .replace(/authorization\s*[:=]\s*[^\s,;]*/gi, 'authorization=[redacted]')
    .slice(0, 300);
}
