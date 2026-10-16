import assert from 'node:assert/strict';
import test from 'node:test';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
  assertPersisted,
  checklistItems,
  childrenOf,
  collectElements,
  draftText,
  extractText,
  generateElementId,
  interpretMe,
  nextPosition,
  parseKind,
  pickHome,
  planCreate,
  planDelete,
  planMove,
  requireColor,
  requireElementId,
  requireLimit,
} from './codec.js';

const META = {
  userId: '69e02074e309d50f749bc4f3',
  now: 1700000000000,
  sessionId: 'msid-aaaaaaaaaa',
  clientId: 'bbbbbb',
  deviceId: 'mdid-cccccccccc',
};

const HOME = 'HomeBoard12345';
const CHILD = 'ChildBoard1234';

function ids(...values) {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (!next) throw new Error('test id queue empty');
    return next;
  };
}

function actions(events) {
  return events.filter((event) => event.event === 'action').map((event) => event.payload);
}

test('draft text round-trips through the stored TipTap document', () => {
  const text = 'line one\n\nline three';
  const document = draftText(text);
  assert.equal(document.type, 'doc');
  assert.equal(extractText({ textContent: document }), text);
  assert.equal(extractText({ textContent: { blocks: [{ text: 'legacy' }] } }), 'legacy');
  assert.equal(extractText({ textContent: 'plain' }), 'plain');
  const rich = 'say **hello** and [go](https://example.com)';
  assert.equal(extractText({ textContent: draftText(rich) }), rich);
  assert.equal(extractText({ textContent: draftText('2 * 3 and *yes*') }), '2 * 3 and *yes*');
});

test('interpretMe finds the user and the workspace root', () => {
  const parsed = interpretMe({
    user: { _id: META.userId, name: 'Ada', email: 'ada@example.com' },
    elements: {
      [HOME]: { id: HOME, elementType: 'BOARD', content: { title: 'Home' }, location: {} },
      [CHILD]: {
        id: CHILD,
        elementType: 'BOARD',
        content: { title: 'Notes' },
        location: { parentId: HOME },
      },
    },
  });
  assert.equal(parsed.userId, META.userId);
  assert.equal(parsed.email, 'ada@example.com');
  assert.equal(parsed.homeBoardId, HOME);
  assert.equal(parsed.homeTitle, 'Home');
});

test('explicit home id wins and a user id is not treated as a board id', () => {
  assert.throws(() => requireElementId(META.userId), ArgumentError);
  const elements = collectElements({
    elements: {
      [CHILD]: { id: CHILD, elementType: 'BOARD', content: { title: 'Notes' } },
    },
  });
  assert.deepEqual(pickHome(elements, CHILD), { homeBoardId: CHILD, homeTitle: 'Notes' });
});

test('children without parent ids belong to the fetched board', () => {
  const elements = collectElements({
    elements: {
      [HOME]: { id: HOME, elementType: 'BOARD', content: { title: 'Home' } },
      NoteCard123456: {
        id: 'NoteCard123456',
        elementType: 'CARD',
        content: { textContent: draftText('hello') },
      },
    },
  });
  const kids = childrenOf(elements, HOME);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].text, 'hello');
});

test('note create plan uses the board channel and draft content', () => {
  const plan = planCreate(META, {
    kind: 'note',
    boardId: HOME,
    parentId: HOME,
    section: 'CANVAS',
    position: { x: 0, y: 8, score: 65536 },
    text: 'hello',
  }, ids('NoteCard123456'));
  const created = actions(plan.events).find((action) => action.type === 'ELEMENT_CREATE');
  assert.equal(created.elementType, 'CARD');
  assert.equal(created.channels[0], `${HOME}-LIVE`);
  assert.equal(created.location.parentId, HOME);
  assert.equal(extractText(created.content), 'hello');
  assert.equal(plan.events[0].payload.type, 'USER_NAVIGATE');
  assert.equal(plan.events[1].event, 'update-channels');
  assert.ok(plan.events.some((event) => event.event === 'sleep'));
});

test('checklist plan nests tasks under the new list', () => {
  const plan = planCreate(META, {
    kind: 'checklist',
    boardId: HOME,
    parentId: 'Column12345678',
    section: 'INBOX',
    position: { index: 0, score: 0 },
    title: 'Ship',
    items: checklistItems('one\ntwo'),
    containerType: 'COLUMN',
  }, ids('List1234567890', 'TaskA123456789', 'TaskB123456789'));
  const creates = actions(plan.events).filter((action) => action.type === 'ELEMENT_CREATE');
  assert.deepEqual(creates.map((action) => action.elementType), ['TASK_LIST', 'TASK', 'TASK']);
  assert.equal(creates[1].location.parentId, 'List1234567890');
  assert.equal(creates[1].location.section, 'INBOX');
  assert.equal(creates[0].content.title, 'Ship');
});

test('delete and move plans keep the element bound to a board channel', () => {
  const element = { id: CHILD, elementType: 'BOARD', parentId: HOME };
  const deleted = planDelete(META, { boardId: HOME, element });
  const deleteAction = actions(deleted).find((action) => action.type === 'ELEMENT_DELETE');
  assert.equal(deleteAction.id, CHILD);
  assert.equal(deleteAction.location.parentId, HOME);
  const moved = planMove(META, {
    boardId: HOME,
    elementId: 'NoteCard123456',
    parentId: 'Column12345678',
    section: 'INBOX',
    position: { index: 1, score: 1 },
  });
  const move = actions(moved).find((action) => action.type === 'ELEMENT_MOVE');
  assert.equal(move.location.parentId, 'Column12345678');
  assert.equal(move.location.section, 'INBOX');
});

test('persisted rows must match the requested text', () => {
  const found = {
    id: 'NoteCard123456',
    elementType: 'CARD',
    title: '',
    text: 'hello',
    url: '',
    checked: false,
    color: '',
    parentId: HOME,
  };
  assert.equal(assertPersisted(found, { id: found.id, elementType: 'CARD', text: 'hello' }).id, found.id);
  assert.throws(() => assertPersisted(found, { id: found.id, text: 'other' }), CommandExecutionMismatch);
});

test('argument guards reject silent clamps and bad colors', () => {
  assert.throws(() => requireLimit(0, 20, 100), ArgumentError);
  assert.throws(() => requireLimit(101, 20, 100), ArgumentError);
  assert.equal(requireLimit(undefined, 20, 100), 20);
  assert.equal(requireColor('336699'), '#336699');
  assert.equal(parseKind('card'), 'note');
  assert.deepEqual(nextPosition([{ index: 2 }], 'INBOX', { index: -1 }), { index: 3, score: 3 });
  assert.match(generateElementId(), /^1[0-9A-Za-z]{15}$/);
  const occupied = [{ x: 0, y: 4, elementType: 'CARD', section: 'CANVAS' }];
  const placed = nextPosition(occupied, 'CANVAS', { x: -1, y: -1, index: -1 }, 'note');
  assert.notDeepEqual([placed.x, placed.y], [0, 4]);
  assert.throws(
    () => nextPosition(occupied, 'CANVAS', { x: 0, y: 4, index: -1 }, 'note'),
    ArgumentError,
  );
});

function CommandExecutionMismatch(error) {
  return error?.code === 'COMMAND_EXEC';
}
