import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import {
  byPosition,
  childrenOf,
  collectComments,
  collectElements,
  isContainerType,
  isElementId,
  isUserId,
  interpretMe,
  payloadError,
  redact,
  requireElementId,
  toListRow,
} from './codec.js';

export const DOMAIN = 'app.milanote.com';
const ORIGIN = 'https://app.milanote.com';
const SESSION_BUDGET_MS = 20000;

function assertAllowedUrl(url) {
  if (url.startsWith('/api/')) return;
  if (url.startsWith('https://app.milanote.com/api/')) return;
  if (url.startsWith('https://upload.milanote.com/api/')) return;
  throw new CommandExecutionError('refusing unexpected Milanote URL');
}

function parseTransport(result) {
  if (!result || result.error) {
    throw new CommandExecutionError(`Milanote request failed: ${redact(result?.error || 'empty response')}`);
  }
  if (result.truncated) {
    throw new CommandExecutionError('Milanote response exceeded 2MB. Open a smaller board.');
  }
  const href = String(result.href || '');
  if (/\/login\b|\/sign-?up\b|\/signup\b/.test(href)) {
    throw new AuthRequiredError(DOMAIN, 'Milanote is showing the login page. Run `opencli milanote login`.');
  }
  const text = String(result.text || '');
  const trimmed = text.trim();
  if (!trimmed) return { status: result.status, href, json: null, html: false };
  if (trimmed.startsWith('<')) {
    return { status: result.status, href, json: null, html: true, snippet: trimmed.slice(0, 160) };
  }
  try {
    return { status: result.status, href, json: JSON.parse(trimmed), html: false };
  } catch {
    throw new CommandExecutionError(`Milanote returned non-JSON (HTTP ${result.status})`);
  }
}

export async function browserJson(page, request, allowRetry = true) {
  assertAllowedUrl(request.url);
  const result = await page.evaluate(async (input) => {
    try {
      const response = await fetch(input.url, {
        method: input.method,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(input.body ? { 'content-type': 'application/json' } : {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
      });
      const text = await response.text();
      const retryAfter = Number(response.headers.get('retry-after'));
      return {
        status: response.status,
        href: location.href,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0,
        truncated: text.length > 2_000_000,
        text: text.length > 2_000_000 ? '' : text,
      };
    } catch (error) {
      return { error: String(error?.message || error), href: location.href };
    }
  }, { method: request.method || 'GET', url: request.url, body: request.body ?? null });

  const parsed = parseTransport(result);
  if (parsed.status === 429 && allowRetry) {
    await page.sleep(Math.min(Math.max(result.retryAfter || 1, 1), 5));
    return browserJson(page, request, false);
  }
  return parsed;
}

async function ensureApp(page) {
  let href = '';
  try {
    href = String(await page.evaluate(() => location.href));
  } catch {
    href = '';
  }
  if (!href.startsWith(`${ORIGIN}/`) && href !== ORIGIN) {
    await page.goto(`${ORIGIN}/`);
    await page.sleep(1.5);
  }
}

async function identityHints(page) {
  return page.evaluate(() => {
    const hints = { userId: '', homeBoardId: '' };
    const userPattern = /^[a-f0-9]{24}$/i;
    const elementPattern = /^[A-Za-z0-9]{6,40}$/;
    try {
      const configured = window.__clientconf || {};
      const candidate = configured.userId || configured.user?.id || configured.user?._id || '';
      if (userPattern.test(candidate)) hints.userId = candidate;
    } catch {
      /* The SPA may not have published client config yet. */
    }
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        if (!String(entry.name).includes('userId=')) continue;
        const id = new URL(entry.name).searchParams.get('userId') || '';
        if (userPattern.test(id)) hints.userId = id;
      }
    } catch {
      /* Resource timing can be empty before the socket opens. */
    }
    const match = location.pathname.match(/^\/([A-Za-z0-9]{6,40})\/?$/);
    if (match && elementPattern.test(match[1]) && !userPattern.test(match[1])) {
      hints.homeBoardId = match[1];
    }
    return hints;
  });
}

function authError() {
  return new AuthRequiredError(DOMAIN, 'Milanote session is missing or expired. Run `opencli milanote login`.');
}

export async function ensureSession(page) {
  await ensureApp(page);
  const deadline = Date.now() + SESSION_BUDGET_MS;
  let lastStatus = 0;
  let parsed = null;
  while (Date.now() < deadline) {
    const response = await browserJson(page, { method: 'GET', url: '/api/users/me' });
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) throw authError();
    if (response.html && /login|sign in/i.test(`${response.href} ${response.snippet || ''}`)) throw authError();
    if (response.status === 200 && response.json) {
      parsed = interpretMe(response.json);
      break;
    }
    if (response.status >= 500) {
      throw new CommandExecutionError(`Milanote /api/users/me failed: HTTP ${response.status}`);
    }
    await page.sleep(1);
  }
  if (!parsed) {
    throw new TimeoutError('milanote session', SESSION_BUDGET_MS / 1000, `Last HTTP status: ${lastStatus}. Run \`opencli milanote login\` if Chrome is not signed in.`);
  }

  if (!parsed.userId || !parsed.homeBoardId) {
    const alt = await browserJson(page, { method: 'GET', url: '/api/users/me/app-init/browser-extension' });
    if (alt.status === 200 && alt.json) {
      const extra = interpretMe(alt.json);
      parsed = {
        ...parsed,
        userId: parsed.userId || extra.userId,
        name: parsed.name || extra.name,
        email: parsed.email || extra.email,
        homeBoardId: parsed.homeBoardId || extra.homeBoardId,
        homeTitle: parsed.homeTitle || extra.homeTitle,
        topKeys: [...parsed.topKeys, ...extra.topKeys.map((key) => `app-init:${key}`)],
      };
    } else if (alt.status === 401 || alt.status === 403) {
      throw authError();
    }
  }

  if (!parsed.userId || !parsed.homeBoardId) {
    const hints = await identityHints(page);
    parsed = {
      ...parsed,
      userId: parsed.userId || (isUserId(hints.userId) ? hints.userId : ''),
      homeBoardId: parsed.homeBoardId || (isElementId(hints.homeBoardId) ? hints.homeBoardId : ''),
    };
  }

  if (!parsed.userId) {
    throw new CommandExecutionError(
      `Milanote /api/users/me did not include a user id. Top-level keys: ${parsed.topKeys.join(', ') || '(none)'}`,
    );
  }
  if (!parsed.homeBoardId) {
    throw new CommandExecutionError(
      `Milanote /api/users/me did not include a home board. Top-level keys: ${parsed.topKeys.join(', ') || '(none)'}. Pass --parent <boardId>.`,
    );
  }
  return parsed;
}

function throwPayloadError(payload, id) {
  const code = payloadError(payload, id);
  if (!code) return;
  if (code === 'BOARD_NOT_FOUND' || code === 'NOT_FOUND' || code === 'ELEMENT_NOT_FOUND') {
    throw new EmptyResultError('milanote get', `${id} was not found`);
  }
  throw new CommandExecutionError(`Milanote ${code} for ${id}`);
}

export async function fetchElementPayload(page, id) {
  const elementId = requireElementId(id, 'id');
  const primary = await browserJson(page, {
    method: 'GET',
    url: `/api/boards?ids=${encodeURIComponent(elementId)}&excludeSelf=false&loadAncestors=false`,
  });
  if (primary.status === 401 || primary.status === 403) throw authError();
  if (primary.status === 404) throw new EmptyResultError('milanote get', `${elementId} was not found`);
  if (primary.status !== 200 || !primary.json) {
    throw new CommandExecutionError(`Milanote element read failed: HTTP ${primary.status}`);
  }
  let payload = primary.json;
  let elements = collectElements(payload);
  if (!elements.some((element) => element.id === elementId)) {
    const alt = await browserJson(page, {
      method: 'GET',
      url: `/api/elements?ids=${encodeURIComponent(elementId)}&loadAncestors=false`,
    });
    if (alt.status === 401 || alt.status === 403) throw authError();
    if (alt.status === 404) throw new EmptyResultError('milanote get', `${elementId} was not found`);
    if (alt.status === 200 && alt.json && collectElements(alt.json).some((element) => element.id === elementId)) {
      payload = alt.json;
      elements = collectElements(payload);
    }
  }
  throwPayloadError(payload, elementId);
  const self = elements.find((element) => element.id === elementId);
  if (self?.elementType === 'SKELETON') {
    throw new EmptyResultError('milanote get', `${elementId} is not accessible`);
  }
  return { payload, elements };
}

export async function loadElement(page, id, options = {}) {
  try {
    const loaded = await fetchElementPayload(page, id);
    return loaded.elements.find((element) => element.id === id) || null;
  } catch (error) {
    if (options.missingOk && error instanceof EmptyResultError) return null;
    throw error;
  }
}

const PARENT_TYPES = new Set(['BOARD', 'DOCUMENT', 'COLUMN', 'TASK_LIST']);

export async function resolveContainer(page, parentId) {
  const seen = new Set();
  let current = parentId;
  let container = null;
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(current)) throw new CommandExecutionError('Milanote parent chain looped');
    seen.add(current);
    const element = await loadElement(page, current);
    if (!element) throw new EmptyResultError('milanote parent', `${current} was not found`);
    if (!container) {
      if (!PARENT_TYPES.has(element.elementType)) {
        throw new CommandExecutionError(
          `parent ${current} is ${element.elementType || 'an unsupported element'}. Use a board, column, or checklist.`,
        );
      }
      container = element;
    }
    if (element.elementType === 'BOARD' || element.elementType === 'DOCUMENT') {
      return { container, board: element };
    }
    if (!element.parentId) throw new CommandExecutionError(`Could not find a board above ${parentId}`);
    current = element.parentId;
  }
  throw new CommandExecutionError('Milanote parent chain is too deep');
}

export async function walkElements(page, rootId, depth, nodeCap) {
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    if (rows.length >= nodeCap) {
      throw new ArgumentError(`result exceeds --limit ${nodeCap}; raise --limit (max 500) or lower --depth`);
    }
    rows.push(row);
  };
  async function expand(id, level) {
    if (seen.has(id)) return;
    seen.add(id);
    const loaded = await fetchElementPayload(page, id);
    const self = loaded.elements.find((element) => element.id === id);
    if (!self) throw new EmptyResultError('milanote tree', `${id} was not found`);
    push(toListRow(self, level));
    if (level >= depth || !isContainerType(self.elementType)) return;
    const kids = childrenOf(loaded.elements, id).sort(byPosition);
    for (const kid of kids) {
      if (isContainerType(kid.elementType)) await expand(kid.id, level + 1);
      else push(toListRow(kid, level + 1));
    }
  }
  await expand(rootId, 0);
  return rows;
}

export async function runCollab(page, userId, events) {
  if (!isUserId(userId)) {
    throw new CommandExecutionError('Milanote collab write needs the signed-in user id. Run `opencli milanote whoami`.');
  }
  if (!Array.isArray(events) || events.length === 0 || events.length > 120) {
    throw new CommandExecutionError('Milanote collab batch is empty or too large');
  }
  const result = await page.evaluate(async ({ userId: signedInUser, events: steps }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const appNode = document.getElementById('app');
    const containerKey = appNode && Object.keys(appNode).find((name) => name.startsWith('__reactContainer'));
    let store = null;
    const queue = containerKey ? [appNode[containerKey]] : [];
    const seen = new Set();
    while (queue.length && !store && seen.size < 40) {
      const node = queue.shift();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const props = node.memoizedProps;
      if (props?.store?.getState) store = props.store;
      if (props?.value?.store?.getState) store = props.value.store;
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }
    if (!store) return { error: 'Milanote is open but its editor state is not ready' };
    const state = store.getState();
    const currentUser = state.get('app')?.get('currentUser');
    const liveUserId = currentUser?.get('_id') || '';
    if (liveUserId !== signedInUser) return { error: 'the open Milanote session does not match the signed-in user' };
    const token = state.get('permissions')?.get('tokens')?.get(0) || '';
    if (!token) return { error: 'Milanote has not issued a permission token for this board yet' };
    const identity = {
      user: {
        _id: liveUserId,
        clientId: currentUser.get('clientId'),
        clientTick: currentUser.get('clientTick'),
      },
      deviceId: localStorage.getItem('mdid') || '',
      sessionId: `msid-${String(currentUser.get('clientId') || 'cli')}cli1`,
      tokens: [token],
    };
    let sent = 0;
    try {
      for (const step of steps) {
        if (step.event === 'sleep') {
          await sleep(Number(step.ms) || 0);
          continue;
        }
        if (step.event !== 'action') continue;
        if (step.payload?.type === 'USER_NAVIGATE') continue;
        identity.user = { ...identity.user, clientTick: Number(identity.user.clientTick || 0) + 1 };
        if (String(step.payload?.type || '').startsWith('COMMENTS_')) {
          store.dispatch({
            ...step.payload,
            userId: identity.user._id,
            tokens: identity.tokens,
            sync: true,
          });
        } else {
          store.dispatch({
            ...step.payload,
            ...identity,
            creationSource: step.payload.creationSource || 'opencli',
            markAsFetched: true,
          });
        }
        sent += 1;
        await sleep(80);
      }
    } catch (error) {
      return { error: String(error?.message || error).slice(0, 240), sent };
    }
    await sleep(400);
    return { ok: true, sent };
  }, { userId, events });

  if (!result?.ok) {
    throw new CommandExecutionError(
      `Milanote collab write failed: ${redact(result?.error)}`,
      'Keep Chrome signed in to app.milanote.com and retry. The element was not confirmed.',
    );
  }
  return result;
}

export async function uploadAttachment(page, file) {
  const result = await page.evaluate(async (input) => {
    let binary;
    try {
      binary = Uint8Array.from(atob(input.base64), (char) => char.charCodeAt(0));
    } catch {
      return { error: 'could not read the file bytes' };
    }
    let response;
    try {
      response = await fetch('/api/elements/attachments/presign', {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: input.filename,
          contentType: input.contentType,
          elementId: input.elementId,
          fileType: input.fileType,
          ...(input.imageType ? { imageType: input.imageType } : {}),
          fileSize: binary.length,
        }),
      });
    } catch (error) {
      return { error: String(error?.message || error) };
    }
    const payload = await response.json().catch(() => ({}));
    const presignedUrl = payload?.presignedUrl || payload?.data?.presignedUrl || '';
    if (!response.ok || typeof presignedUrl !== 'string' || !presignedUrl.startsWith('https://')) {
      const keys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 8).join(',') : '';
      return { error: `presign HTTP ${response.status}${keys ? ` (${keys})` : ''}` };
    }
    let host = '';
    try { host = new URL(presignedUrl).host; } catch { host = ''; }
    const put = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      body: binary,
    });
    return { ok: put.ok, putStatus: put.status, host };
  }, file);
  if (!result?.ok) {
    throw new CommandExecutionError(
      `Milanote upload failed: ${redact(result?.error || `storage PUT HTTP ${result?.putStatus || 'unknown'}`)}`,
    );
  }
  return result;
}

export async function loadComments(page, id) {
  const loaded = await fetchElementPayload(page, id);
  let rows = collectComments(loaded.payload, loaded.elements);
  if (rows.length) return rows;
  const threads = await browserJson(page, {
    method: 'GET',
    url: `/api/comments/threads?elementIds=${encodeURIComponent(id)}`,
  });
  if (threads.status === 200 && threads.json) {
    rows = collectComments(threads.json, [...loaded.elements, ...collectElements(threads.json)]);
  }
  return rows;
}

export async function confirmedElement(page, id) {
  let found = await loadElement(page, id, { missingOk: true });
  if (!found) {
    await page.sleep(1);
    found = await loadElement(page, id, { missingOk: true });
  }
  return found;
}
