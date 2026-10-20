import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calibrate,
  contentToUnits,
  footprintPoints,
  grabOffset,
  plainText,
  sameText,
  scrollDelta,
  typingSteps,
  unitsToContent,
} from './uiplan.js';

test('plain lines type as text and Enter', () => {
  assert.deepEqual(typingSteps('one\ntwo'), [
    { type: 'text', text: 'one' },
    { type: 'enter' },
    { type: 'text', text: 'two' },
  ]);
});

test('bold is toggled on and off around its run', () => {
  assert.deepEqual(typingSteps('**对话** conversation'), [
    { type: 'mark', mark: 'bold' },
    { type: 'text', text: '对话' },
    { type: 'mark', mark: 'bold' },
    { type: 'text', text: ' conversation' },
  ]);
});

test('a mark left open at the end of a line is closed before Enter', () => {
  const steps = typingSteps('**open\nnext');
  const enter = steps.findIndex((step) => step.type === 'enter');
  assert.deepEqual(steps.slice(0, enter), [
    { type: 'mark', mark: 'bold' },
    { type: 'text', text: 'open' },
    { type: 'mark', mark: 'bold' },
  ]);
  assert.deepEqual(steps.slice(enter + 1), [{ type: 'text', text: 'next' }]);
});

test('links are typed as label and url', () => {
  assert.deepEqual(typingSteps('[doc](https://example.com/a)'), [
    { type: 'text', text: 'doc (https://example.com/a)' },
  ]);
});

test('blank lines become empty paragraphs', () => {
  assert.deepEqual(typingSteps('a\n\nb').map((step) => step.type), ['text', 'enter', 'enter', 'text']);
});

test('plainText drops markers and keeps link targets', () => {
  assert.equal(plainText('**定义**：*一串*消息 [doc](https://x.io/a)'), '定义：一串消息 doc (https://x.io/a)');
  assert.equal(plainText('  a  \n  b '), 'a\nb');
});

test('plainText ignores list, heading and quote markers the editor may convert', () => {
  assert.equal(plainText('- one\n2. two\n## three\n> four\n[ ] five'), 'one\ntwo\nthree\nfour\nfive');
  assert.equal(sameText('one\ntwo', '- one\n- two'), true);
  assert.equal(plainText('a - b'), 'a - b');
});

test('sameText matches a stored note against what was typed, formatting included', () => {
  assert.equal(sameText('**对话**（conversation）\n第二行', '**对话**（conversation）\n第二行'), true);
  assert.equal(sameText('对话（conversation）', '**对话**（conversation）'), false);
  assert.equal(sameText('***复审*****：改文字**', '*复审*：改文字'), false);
  assert.equal(sameText('*复审*：改文字', '*复审*：改文字'), true);
  assert.equal(sameText('对话', '会话'), false);
  assert.equal(sameText(null, 'x'), false);
});

test('sameText compares text with links without formatting', () => {
  assert.equal(sameText('see doc (https://x.io/a)', 'see [doc](https://x.io/a)'), true);
  assert.equal(sameText('see doc', 'see [doc](https://x.io/a)'), false);
});

test('calibrate takes the widest pair for scale', () => {
  const cal = calibrate([
    { x: 0, y: 80, left: 352, top: 744 },
    { x: 52, y: 80, left: 768, top: 744 },
    { x: 104, y: 106, left: 1184, top: 952 },
  ]);
  assert.equal(cal.scale, 8);
  assert.equal(cal.ox, 352);
  assert.equal(cal.oy, 104);
  assert.deepEqual(unitsToContent(cal, 160, -2), { left: 1632, top: 88 });
  assert.deepEqual(contentToUnits(cal, 1632, 88), { x: 160, y: -2 });
});

test('calibrate falls back to the default scale with one reference', () => {
  assert.deepEqual(calibrate([{ x: 10, y: 5, left: 100, top: 60 }]), { scale: 8, ox: 20, oy: 20 });
  assert.equal(calibrate([]), null);
});

test('calibrate uses the vertical spread when x does not vary', () => {
  const cal = calibrate([{ x: 4, y: 0, left: 40, top: 0 }, { x: 4, y: 10, left: 40, top: 100 }]);
  assert.equal(cal.scale, 10);
});

test('scrollDelta brings a box inside the margin and leaves visible boxes alone', () => {
  const view = { scrollLeft: 0, scrollTop: 0, width: 1000, height: 600 };
  assert.deepEqual(scrollDelta(view, { left: 100, top: 100, width: 200, height: 80 }), { x: 0, y: 0 });
  assert.deepEqual(scrollDelta(view, { left: 100, top: 900, width: 200, height: 80 }), { x: 0, y: 440 });
  assert.deepEqual(scrollDelta({ ...view, scrollTop: 500 }, { left: 100, top: 100, width: 200, height: 80 }), { x: 0, y: -460 });
});

test('footprintPoints samples a 3x3 grid inside the box', () => {
  const points = footprintPoints({ left: 0, top: 0, width: 100, height: 40 });
  assert.equal(points.length, 9);
  assert.ok(points.every(({ x, y }) => x > 0 && x < 100 && y > 0 && y < 40));
});

test('columns are grabbed by the title bar', () => {
  assert.deepEqual(grabOffset('COLUMN', 270), { x: 120, y: 18 });
  assert.deepEqual(grabOffset('CARD', 270), { x: 14, y: 14 });
});
