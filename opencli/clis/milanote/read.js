import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  COMMENT_COLUMNS,
  DETAIL_COLUMNS,
  LIST_COLUMNS,
  byPosition,
  childrenOf,
  collectComments,
  collectElements,
  requireDepth,
  requireElementId,
  requireLimit,
  toDetailRow,
  toListRow,
} from './codec.js';
import {
  LINK_ARG,
  accessUrl,
  applyShareLink,
  browserJson,
  ensureSession,
  fetchElementPayload,
  walkElements,
} from './session.js';

function defineMilanoteCommand(options) {
  cli({
    site: 'milanote',
    domain: 'app.milanote.com',
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    ...options,
    args: [...(options.args || []), LINK_ARG],
    func: async (page, args) => options.func(page, await applyShareLink(page, args)),
  });
}

async function resolveRoot(page, parent) {
  const session = await ensureSession(page);
  const rootId = parent ? requireElementId(parent, 'parent') : session.homeBoardId;
  return { session, rootId };
}

defineMilanoteCommand({
  name: 'boards',
  access: 'read',
  description: 'List boards directly inside the home board or another board',
  example: 'opencli milanote boards -f yaml',
  args: [
    { name: 'parent', default: '', help: 'Board id. Defaults to the home board from `milanote whoami`' },
    { name: 'limit', type: 'int', default: 100, help: 'Maximum boards to return (1-500). Fails instead of truncating' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const limit = requireLimit(args.limit, 100, 500);
    const { rootId } = await resolveRoot(page, args.parent);
    const loaded = await fetchElementPayload(page, rootId);
    const rows = childrenOf(loaded.elements, rootId)
      .filter((element) => element.elementType === 'BOARD' || element.elementType === 'DOCUMENT')
      .sort(byPosition)
      .map((element) => toListRow(element, 1));
    if (rows.length === 0) {
      throw new EmptyResultError('milanote boards', `No boards under ${rootId}. Create one with \`opencli milanote create --type board --title "..."\`.`);
    }
    if (rows.length > limit) {
      throw new ArgumentError(`parent has ${rows.length} boards; raise --limit (max 500)`);
    }
    return rows;
  },
});

defineMilanoteCommand({
  name: 'board',
  aliases: ['children'],
  access: 'read',
  description: 'List the direct children of a board, column, or checklist',
  example: 'opencli milanote board <id> -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Board, column, or checklist id' },
    { name: 'limit', type: 'int', default: 200, help: 'Maximum children to return (1-500). Fails instead of truncating' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const limit = requireLimit(args.limit, 200, 500);
    const id = requireElementId(args.id, 'id');
    await ensureSession(page);
    const loaded = await fetchElementPayload(page, id);
    const rows = childrenOf(loaded.elements, id).sort(byPosition).map((element) => toListRow(element, 1));
    if (rows.length === 0) {
      throw new EmptyResultError('milanote board', `${id} has no child elements.`);
    }
    if (rows.length > limit) {
      throw new ArgumentError(`board has ${rows.length} elements; raise --limit (max 500)`);
    }
    return rows;
  },
});

defineMilanoteCommand({
  name: 'get',
  aliases: ['show'],
  access: 'read',
  description: 'Read one Milanote element, including note text',
  example: 'opencli milanote get <id> -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Element id' },
  ],
  columns: DETAIL_COLUMNS,
  func: async (page, args) => {
    const id = requireElementId(args.id, 'id');
    await ensureSession(page);
    const loaded = await fetchElementPayload(page, id);
    const element = loaded.elements.find((item) => item.id === id);
    if (!element) throw new EmptyResultError('milanote get', `${id} was not found`);
    return [toDetailRow(element, childrenOf(loaded.elements, id).length)];
  },
});

defineMilanoteCommand({
  name: 'tree',
  access: 'read',
  description: 'Read a board and the boards, columns, and checklists nested inside it',
  example: 'opencli milanote tree --id <id> --depth 2 -f yaml',
  args: [
    { name: 'id', default: '', help: 'Root board id. Defaults to the home board' },
    { name: 'depth', type: 'int', default: 2, help: 'How many levels below the root to open (0-6)' },
    { name: 'limit', type: 'int', default: 200, help: 'Maximum elements to return (1-500). Fails instead of truncating' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const depth = requireDepth(args.depth, 2);
    const limit = requireLimit(args.limit, 200, 500);
    const { rootId } = await resolveRoot(page, args.id);
    return walkElements(page, rootId, depth, limit);
  },
});

defineMilanoteCommand({
  name: 'search',
  access: 'read',
  description: 'Find elements by title, text, URL, or color under a board',
  example: 'opencli milanote search --query "launch" --parent <boardId> -f yaml',
  args: [
    { name: 'query', required: true, help: 'Case-insensitive text to find' },
    { name: 'parent', default: '', help: 'Board to search. Defaults to the home board' },
    { name: 'depth', type: 'int', default: 2, help: 'How many levels below the root to open (0-6)' },
    { name: 'limit', type: 'int', default: 50, help: 'Maximum matches (1-200). Fails if more matches exist' },
  ],
  columns: LIST_COLUMNS,
  func: async (page, args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new ArgumentError('--query is required');
    if (query.length > 200) throw new ArgumentError('--query must be <= 200 characters');
    const depth = requireDepth(args.depth, 2);
    const limit = requireLimit(args.limit, 50, 200);
    const { rootId } = await resolveRoot(page, args.parent);
    let rows;
    try {
      rows = await walkElements(page, rootId, depth, 500);
    } catch (error) {
      if (error instanceof ArgumentError) {
        throw new ArgumentError('search space exceeds 500 elements; lower --depth or choose a narrower --parent');
      }
      throw error;
    }
    const needle = query.toLowerCase();
    const matches = rows.filter((row) => `${row.title}\n${row.text}\n${row.url}\n${row.color}`.toLowerCase().includes(needle));
    if (matches.length === 0) {
      throw new EmptyResultError('milanote search', `No elements under ${rootId} matched "${query}" within depth ${depth}.`);
    }
    if (matches.length > limit) {
      throw new ArgumentError(`${matches.length} elements matched; raise --limit (max 200) or narrow --query`);
    }
    return matches;
  },
});

defineMilanoteCommand({
  name: 'comments',
  access: 'read',
  description: 'List comments loaded with a board',
  example: 'opencli milanote comments <boardId> -f yaml',
  args: [
    { name: 'id', positional: true, required: true, help: 'Board id' },
  ],
  columns: COMMENT_COLUMNS,
  func: async (page, args) => {
    const id = requireElementId(args.id, 'id');
    await ensureSession(page);
    const loaded = await fetchElementPayload(page, id);
    let rows = collectComments(loaded.payload, loaded.elements);
    if (rows.length === 0) {
      const alt = await browserJson(page, {
        method: 'GET',
        url: accessUrl(page, `/api/boards/${encodeURIComponent(id)}?loadAncestors=false`),
      });
      if (alt.status === 200 && alt.json) {
        rows = collectComments(alt.json, [...loaded.elements, ...collectElements(alt.json)]);
      }
    }
    if (rows.length === 0) throw new EmptyResultError('milanote comments', `${id} has no comments.`);
    return rows;
  },
});
