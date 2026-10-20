// Editor-input fallback. Some boards drop the actions this adapter builds
// ("did not persist" / "did not delete") while the same board accepts the same
// change made in the editor (verified 2026-10-19). These helpers repeat the change
// with trusted CDP mouse and keyboard input, so Milanote's own code builds and
// signs the write. Page scripts here read geometry and, to bring a spot on screen,
// set the canvas scroll position; they never dispatch events or touch the store.
// (A CDP mouse-wheel event waits for a painted frame and hangs on a hidden tab.)
//
// The adapter tab usually sits in the background, where Chrome paints no frames
// and Milanote's edit mode waits for one. kick() forces a frame with a screenshot
// through the bridge; a raw CDP Page.captureScreenshot hangs on a hidden tab.
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { childrenOf } from './codec.js';
import { fetchElementPayload, loadElement } from './session.js';
import {
  calibrate,
  contentToUnits,
  footprintPoints,
  grabOffset,
  markShortcut,
  sameText,
  scrollDelta,
  typingSteps,
  unitsToContent,
} from './uiplan.js';

const ORIGIN = 'https://app.milanote.com';
const STARTED = Date.now();

// MILANOTE_UI_DEBUG=1 prints each step with elapsed seconds to stderr.
function trace(message) {
  if (process.env.MILANOTE_UI_DEBUG) console.error(`[milanote-ui +${((Date.now() - STARTED) / 1000).toFixed(1)}s] ${message}`);
}
const NOTE_UNITS = { w: 34, h: 10 };
const MOD_SHIFT = 8;

async function kick(page) {
  try {
    await page.screenshot({ format: 'jpeg', quality: 10 });
  } catch {
    /* A missed frame only slows the polling below. */
  }
}

async function readView(page, ids = []) {
  return page.evaluate((input) => {
    const viewport = document.querySelector('.CanvasViewport');
    if (!viewport) return null;
    const box = viewport.getBoundingClientRect();
    const rects = {};
    for (const id of input.ids) {
      const node = document.querySelector(`.CanvasElement[data-element-id="${id}"]`)
        || document.querySelector(`[data-element-id="${id}"]`);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      rects[id] = {
        left: r.left - box.left + viewport.scrollLeft,
        top: r.top - box.top + viewport.scrollTop,
        width: r.width,
        height: r.height,
      };
    }
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      rects,
      ids: [...document.querySelectorAll('.CanvasElement[data-element-id]')].map((node) => node.dataset.elementId),
      href: location.href,
      visible: document.visibilityState === 'visible',
      mac: /Mac|iPhone|iPad/.test(navigator.platform || ''),
    };
  }, { ids });
}

// What sits under each screen point: 'canvas', 'element:<id>', or 'other'.
async function probePoints(page, points) {
  return page.evaluate((input) => input.points.map(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return 'other';
    if (hit.classList.contains('canvas-document')) return 'canvas';
    const owner = hit.closest('[data-element-id]');
    return owner ? `element:${owner.dataset.elementId}` : 'other';
  }), { points });
}

async function editable(page, id) {
  return page.evaluate((input) => {
    const editor = document.querySelector(`[data-element-id="${input.id}"] .ProseMirror`);
    return Boolean(editor && editor.getAttribute('contenteditable') === 'true');
  }, { id });
}

async function buttonRect(page, label) {
  return page.evaluate((input) => {
    const node = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((item) => (item.innerText || '').trim() === input.label);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, { label });
}

async function trashCenter(page) {
  return page.evaluate(() => {
    const node = document.querySelector('.Toolbar .Trash');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
}

function toScreen(view, point) {
  return { x: view.left + point.left - view.scrollLeft, y: view.top + point.top - view.scrollTop };
}

async function mouse(page, type, point, extra = {}) {
  await page.cdp('Input.dispatchMouseEvent', { type, x: Math.round(point.x), y: Math.round(point.y), ...extra });
}

async function click(page, point, count = 1) {
  await mouse(page, 'mouseMoved', point);
  for (let n = 1; n <= count; n += 1) {
    await mouse(page, 'mousePressed', point, { button: 'left', buttons: 1, clickCount: n });
    await mouse(page, 'mouseReleased', point, { button: 'left', buttons: 0, clickCount: n });
  }
}

async function drag(page, from, to) {
  await mouse(page, 'mouseMoved', from);
  await mouse(page, 'mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
  let last = from;
  try {
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      last = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await mouse(page, 'mouseMoved', last, { button: 'left', buttons: 1 });
      if (i % 3 === 0) await kick(page);
    }
  } finally {
    // A button left down would turn the next click into part of this drag.
    await mouse(page, 'mouseReleased', last, { button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
  }
  await kick(page);
  await kick(page);
}

// Refuse to press unless the element we mean is the one under the pointer.
async function requireUnder(page, point, id, action) {
  const [hit] = await probePoints(page, [point]);
  if (hit !== `element:${id}`) {
    throw new CommandExecutionError(`${action}: ${id} is not under the pointer (found ${hit}); nothing was changed`);
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
};

const HIDDEN = 'the Milanote tab is hidden (its OpenCLI Chrome window is minimized), so the editor cannot take input; restore that window, then retry';

// The window can be minimized while a command runs; input sent then waits for a
// frame that never comes. Check right before each burst of input.
async function ensureVisible(page) {
  const visible = await page.evaluate(() => document.visibilityState === 'visible').catch(() => false);
  if (!visible) throw new CommandExecutionError(HIDDEN);
}

async function press(page, key, modifiers = 0) {
  const letter = /^[a-z]$/.test(key);
  const known = KEYS[key] || { code: letter ? `Key${key.toUpperCase()}` : key, keyCode: letter ? key.toUpperCase().charCodeAt(0) : 0 };
  const base = { key, code: known.code, windowsVirtualKeyCode: known.keyCode, nativeVirtualKeyCode: known.keyCode, modifiers };
  await page.cdp('Input.dispatchKeyEvent', { type: modifiers ? 'rawKeyDown' : 'keyDown', ...base });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function typeMarkdown(page, text, mod) {
  for (const step of typingSteps(text)) {
    if (step.type === 'text') {
      if (step.text) await page.cdp('Input.insertText', { text: step.text });
    } else if (step.type === 'enter') {
      await press(page, 'Enter');
    } else {
      const shortcut = markShortcut(step.mark);
      await press(page, shortcut.key, mod | (shortcut.shift ? MOD_SHIFT : 0));
    }
  }
}

async function scrollBy(page, dx, dy) {
  await page.evaluate((input) => {
    const viewport = document.querySelector('.CanvasViewport');
    if (viewport) viewport.scrollBy(input.dx, input.dy);
  }, { dx, dy });
  await kick(page);
}

// Scroll (with the wheel) until a content-space box is on screen.
async function reveal(page, box, ids = []) {
  let view = await readView(page, ids);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const delta = scrollDelta(view, box);
    if (Math.abs(delta.x) < 2 && Math.abs(delta.y) < 2) return view;
    await scrollBy(page, delta.x, delta.y);
    view = await readView(page, ids);
  }
  return view;
}

// The bridge keeps its tabs in one Chrome window, and only the selected tab paints.
async function selectOwnTab(page, href) {
  try {
    const tabs = await page.tabs();
    trace(`tabs: ${JSON.stringify(tabs.map((tab) => ({ index: tab.index, active: tab.active, page: tab.page, url: String(tab.url).slice(-40) })))} self=${page.getActivePage?.()}`);
    const mine = tabs.find((tab) => tab.url === href);
    // The bridge marks its own lease tab active even when Chrome shows another tab
    // in that window, so select it regardless.
    if (mine) await page.selectTab(mine.page ?? mine.index);
  } catch {
    /* Selecting is a convenience; the visibility check below decides. */
  }
}

async function dismissPrompts(page) {
  for (const label of ['Not now']) {
    const point = await buttonRect(page, label);
    if (point) {
      await click(page, point);
      await kick(page);
    }
  }
}

export async function openBoard(page, boardId) {
  trace(`open board ${boardId}`);
  let view = await readView(page).catch(() => null);
  if (!view || !String(view.href).startsWith(`${ORIGIN}/${boardId}`)) {
    trace(`goto from ${view && view.href}`);
    await page.goto(`${ORIGIN}/${boardId}/`);
    trace('goto returned');
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await kick(page);
    view = await readView(page).catch(() => null);
    trace(`board check ${attempt}: ${view && view.href} ids=${view && view.ids.length}`);
    if (view && String(view.href).startsWith(`${ORIGIN}/${boardId}`) && (view.ids.length || attempt >= 4)) {
      if (!view.visible) {
        await selectOwnTab(page, view.href);
        for (let wait = 0; wait < 6 && !(view && view.visible); wait += 1) {
          await page.sleep(0.5);
          view = await readView(page).catch(() => null);
        }
      }
      // A hidden page (its Chrome window minimized) takes no input; CDP input
      // events then wait for a frame that never comes.
      if (!view || !view.visible) {
        throw new CommandExecutionError(HIDDEN);
      }
      await dismissPrompts(page);
      return view;
    }
    await page.sleep(0.5);
  }
  throw new CommandExecutionError(`Milanote board ${boardId} did not open in the editor`);
}

async function calibrateBoard(page, boardId) {
  const loaded = await fetchElementPayload(page, boardId);
  const children = childrenOf(loaded.elements, boardId)
    .filter((item) => item.section === 'CANVAS' && item.elementType !== 'LINE'
      && Number.isFinite(item.x) && Number.isFinite(item.y));
  const view = await readView(page, children.map((item) => item.id));
  const refs = children
    .filter((item) => view.rects[item.id])
    .map((item) => ({ x: item.x, y: item.y, left: view.rects[item.id].left, top: view.rects[item.id].top }));
  return { calibration: calibrate(refs), view };
}

// Polls the API until accept(element) holds. Returns { element } (element may be
// null when absence is what we waited for) or null on timeout.
// After a delete, Milanote answers a read with "<id> was deleted" rather than an
// empty result; both mean the element is gone.
async function loadOrGone(page, id) {
  try {
    return await loadElement(page, id, { missingOk: true });
  } catch (error) {
    if (/DELETED|not found/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

async function waitStored(page, id, accept, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const element = await loadOrGone(page, id);
    if (accept(element)) return { element };
    await kick(page);
    await page.sleep(0.75);
  }
  return null;
}

async function waitEditable(page, id, reopen) {
  for (let round = 0; round < 2; round += 1) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await kick(page);
      if (await editable(page, id)) return true;
      await page.sleep(0.25);
    }
    if (reopen && round === 0) await reopen();
  }
  return false;
}

// The note a double-click made: new since the click, covering the click point, empty.
async function newNoteAt(page, before, point) {
  return page.evaluate((input) => {
    const known = new Set(input.before);
    for (const node of document.querySelectorAll('.CanvasElement[data-element-id]')) {
      const id = node.dataset.elementId;
      if (known.has(id)) continue;
      const r = node.getBoundingClientRect();
      // The note snaps to the grid, so its corner can sit up to one cell past the click.
      const covers = input.x >= r.left - 12 && input.x <= r.right && input.y >= r.top - 12 && input.y <= r.bottom;
      const editor = node.querySelector('.ProseMirror');
      if (covers && editor && !editor.innerText.trim()) return id;
    }
    return null;
  }, { before: [...before], x: point.x, y: point.y });
}

function modifierFor(view) {
  return view.mac ? 4 : 2;
}

// Candidate top-left positions for a new note, in grid units.
function noteCandidates(calibration, view, wanted, explicit) {
  if (calibration && wanted) {
    const out = [wanted];
    if (!explicit) {
      for (let k = 1; k <= 12; k += 1) out.push({ x: wanted.x, y: wanted.y + k * (NOTE_UNITS.h + 4) });
      for (let k = 1; k <= 4; k += 1) out.push({ x: wanted.x + k * (NOTE_UNITS.w + 4), y: wanted.y });
    }
    return out;
  }
  // An empty board has nothing to calibrate against: use the visible area.
  const scale = 8;
  const base = { ox: 0, oy: 0, scale };
  const start = contentToUnits(base, view.scrollLeft + view.width / 4, view.scrollTop + view.height / 4);
  return Array.from({ length: 6 }, (_, k) => ({ x: start.x, y: start.y + k * (NOTE_UNITS.h + 4), base }));
}

export async function createNoteViaUi(page, { boardId, x, y, text, explicit }) {
  await openBoard(page, boardId);
  const { calibration, view: first } = await calibrateBoard(page, boardId);
  const wanted = x >= 0 && y >= 0 ? { x, y } : null;
  if (explicit && !calibration) {
    throw new CommandExecutionError('cannot honor --x/--y: nothing on this board is on screen to measure against; omit --x/--y, or use --via api');
  }
  const mod = modifierFor(first);
  let chosen = null;
  let view = first;
  for (const spot of noteCandidates(calibration, first, wanted, explicit)) {
    const cal = spot.base || calibration;
    const corner = unitsToContent(cal, spot.x, spot.y);
    const box = { left: corner.left, top: corner.top, width: NOTE_UNITS.w * cal.scale, height: NOTE_UNITS.h * cal.scale };
    view = await reveal(page, box);
    const hits = await probePoints(page, footprintPoints(box).map((point) => toScreen(view, { left: point.x, top: point.y })));
    if (hits.every((hit) => hit === 'canvas')) {
      chosen = box;
      break;
    }
    if (explicit) throw new CommandExecutionError(`position ${x},${y} is covered on screen; pick another --x/--y`);
  }
  if (!chosen) throw new CommandExecutionError('no empty spot on screen for the note; pass --x and --y');

  trace(`spot ${JSON.stringify(chosen)} scale=${calibration && calibration.scale}`);
  const before = new Set(view.ids);
  const point = toScreen(view, { left: chosen.left + 6, top: chosen.top + 6 });
  await ensureVisible(page);
  await click(page, point, 2);
  let id = null;
  for (let attempt = 0; attempt < 12 && !id; attempt += 1) {
    await kick(page);
    id = await newNoteAt(page, before, point);
    if (!id) await page.sleep(0.25);
  }
  if (!id) throw new CommandExecutionError('double-clicking the canvas did not create a note');
  trace(`new note ${id}`);

  const reopen = async () => {
    const now = await readView(page, [id]);
    const rect = now.rects[id];
    if (rect) await click(page, toScreen(now, { left: rect.left + rect.width / 2, top: rect.top + Math.min(rect.height / 2, 24) }), 2);
  };
  if (!(await waitEditable(page, id, reopen))) throw new CommandExecutionError(`new note ${id} never entered edit mode`);
  trace('editing; typing');
  await ensureVisible(page);
  await typeMarkdown(page, text, mod);
  await kick(page);
  await press(page, 'Escape');
  await kick(page);
  trace('typed; waiting for the API');
  const stored = await waitStored(page, id, (element) => Boolean(element) && sameText(element.text, text));
  if (!stored) throw new CommandExecutionError(`note ${id} was typed in the editor but its text did not save`);
  return stored.element;
}

export async function updateTextViaUi(page, { boardId, element, text }) {
  await openBoard(page, boardId);
  let view = await readView(page, [element.id]);
  const rect = view.rects[element.id];
  if (!rect) throw new CommandExecutionError(`${element.id} is not on screen in board ${boardId}`);
  view = await reveal(page, rect, [element.id]);
  const target = () => {
    const r = view.rects[element.id] || rect;
    return toScreen(view, { left: r.left + Math.min(r.width / 2, 60), top: r.top + Math.min(r.height / 2, 24) });
  };
  await ensureVisible(page);
  await click(page, target(), 2);
  const reopen = async () => {
    view = await readView(page, [element.id]);
    await click(page, target(), 2);
  };
  if (!(await waitEditable(page, element.id, reopen))) throw new CommandExecutionError(`${element.id} never entered edit mode`);
  const mod = modifierFor(view);
  await ensureVisible(page);
  // Typing over a selection keeps the marks at its start (a bold first word would
  // make the whole new text bold), so delete the old text first.
  await press(page, 'a', mod);
  await press(page, 'Backspace');
  await typeMarkdown(page, text, mod);
  await kick(page);
  await press(page, 'Escape');
  await kick(page);
  const stored = await waitStored(page, element.id, (found) => Boolean(found) && sameText(found.text, text));
  if (!stored) throw new CommandExecutionError(`${element.id} was edited in the editor but the new text did not save`);
  return stored.element;
}

export async function deleteViaUi(page, { boardId, element }) {
  await openBoard(page, boardId);
  let view = await readView(page, [element.id]);
  const rect = view.rects[element.id];
  if (!rect) throw new CommandExecutionError(`${element.id} is not on screen in board ${boardId}`);
  view = await reveal(page, rect, [element.id]);
  const now = view.rects[element.id] || rect;
  const grab = grabOffset(element.elementType, now.width);
  const trash = await trashCenter(page);
  if (!trash) throw new CommandExecutionError('the Trash drop target is not on screen');
  const from = toScreen(view, { left: now.left + grab.x, top: now.top + grab.y });
  await requireUnder(page, from, element.id, 'delete');
  await ensureVisible(page);
  await drag(page, from, trash);
  const gone = await waitStored(page, element.id, (found) => !found || found.elementType === 'SKELETON');
  if (!gone) throw new CommandExecutionError(`${element.id} was dragged to Trash but is still on the board`);
  return true;
}

// Canvas-to-canvas move on the same board, in hops that fit on screen.
export async function moveViaUi(page, { boardId, element, x, y }) {
  await openBoard(page, boardId);
  const { calibration } = await calibrateBoard(page, boardId);
  if (!calibration) throw new CommandExecutionError(`cannot place ${element.id}: no reference elements on board ${boardId}`);
  for (let hop = 0; hop < 8; hop += 1) {
    let view = await readView(page, [element.id]);
    const rect = view.rects[element.id];
    if (!rect) throw new CommandExecutionError(`${element.id} is not on screen in board ${boardId}`);
    const at = contentToUnits(calibration, rect.left, rect.top);
    if (at.x === x && at.y === y) break;
    const goal = unitsToContent(calibration, x, y);
    const room = { x: Math.max(80, view.width - rect.width - 160), y: Math.max(80, view.height - rect.height - 160) };
    const step = {
      left: rect.left + Math.max(-room.x, Math.min(room.x, goal.left - rect.left)),
      top: rect.top + Math.max(-room.y, Math.min(room.y, goal.top - rect.top)),
    };
    const span = {
      left: Math.min(rect.left, step.left),
      top: Math.min(rect.top, step.top),
      width: Math.abs(step.left - rect.left) + rect.width,
      height: Math.abs(step.top - rect.top) + rect.height,
    };
    view = await reveal(page, span, [element.id]);
    const live = view.rects[element.id] || rect;
    const grab = grabOffset(element.elementType, live.width);
    const from = toScreen(view, { left: live.left + grab.x, top: live.top + grab.y });
    await requireUnder(page, from, element.id, 'move');
    // Dropping onto another element can file it into a column; only drop on empty canvas.
    const landing = { left: step.left, top: step.top, width: live.width, height: live.height };
    const hits = await probePoints(page, footprintPoints(landing).map((p) => toScreen(view, { left: p.x, top: p.y })));
    if (!hits.every((hit) => hit === 'canvas' || hit === `element:${element.id}`)) {
      throw new CommandExecutionError(`move: the way to ${x},${y} is covered by another element; nothing more was moved`);
    }
    await ensureVisible(page);
    await drag(page, from, toScreen(view, { left: step.left + grab.x, top: step.top + grab.y }));
  }
  const stored = await waitStored(page, element.id, (found) => Boolean(found)
    && found.parentId === element.parentId && found.section === 'CANVAS'
    && Math.abs(found.x - x) <= 1 && Math.abs(found.y - y) <= 1);
  if (!stored) throw new CommandExecutionError(`${element.id} was dragged but did not land at ${x},${y}`);
  return stored.element;
}
