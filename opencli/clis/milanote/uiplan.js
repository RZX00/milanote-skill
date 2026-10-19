// Pure helpers for the editor-input fallback in ui.js: turning note markdown into
// keystrokes, comparing what Milanote stored with what was typed, and mapping
// board grid units to screen pixels. No browser access here, so it is unit-tested.
import { draftText, extractText } from './codec.js';

// Marks the editor can toggle from the keyboard (TipTap defaults). Links have no
// shortcut, so a link is typed as "label (url)".
const MARK_KEYS = {
  bold: { key: 'b', shift: false },
  italic: { key: 'i', shift: false },
  strike: { key: 's', shift: true },
  code: { key: 'e', shift: false },
};
const MARK_ORDER = ['bold', 'italic', 'strike', 'code'];

function nodeMarks(node) {
  return new Set((node.marks || []).map((mark) => mark.type).filter((type) => MARK_KEYS[type]));
}

function nodeText(node) {
  const link = (node.marks || []).find((mark) => mark.type === 'link');
  return link?.attrs?.href ? `${node.text} (${link.attrs.href})` : node.text;
}

// Steps: { type: 'text', text } | { type: 'mark', mark } (toggle) | { type: 'enter' }.
export function typingSteps(text) {
  const steps = [];
  const paragraphs = draftText(text).content;
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) steps.push({ type: 'enter' });
    const active = new Set();
    for (const node of paragraph.content || []) {
      const wanted = nodeMarks(node);
      for (const mark of MARK_ORDER) {
        if (active.has(mark) !== wanted.has(mark)) {
          steps.push({ type: 'mark', mark });
          if (active.has(mark)) active.delete(mark);
          else active.add(mark);
        }
      }
      steps.push({ type: 'text', text: nodeText(node) });
    }
    // Stored marks would leak into the next paragraph; close them before Enter.
    for (const mark of MARK_ORDER) {
      if (active.has(mark)) steps.push({ type: 'mark', mark });
    }
  });
  return steps;
}

export function markShortcut(mark) {
  return MARK_KEYS[mark];
}

// Line starts the editor may turn into a list item, heading or quote as they are typed.
const BLOCK_MARKER = /^(?:[-+*]|\d+[.)]|#{1,6}|>|\[[ xX]?\])\s+/;

// Text as a reader sees it: markdown markers removed, links as "label (url)",
// block markers at line starts dropped, whitespace collapsed. Used to confirm a
// typed note, which cannot carry links and may have become a list.
export function plainText(text) {
  return draftText(String(text ?? ''))
    .content
    .map((paragraph) => (paragraph.content || []).map(nodeText).join(''))
    .map((line) => line.trim().replace(BLOCK_MARKER, ''))
    .join('\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const HAS_LINK = /\[[^\]]+\]\(https?:\/\/[^\s)]+\)/;

// Markdown in the form the adapter reads it back: parsed and re-serialized, block
// markers at line starts dropped, spacing collapsed.
function canonical(text) {
  return extractText({ textContent: draftText(String(text ?? '')) })
    .split('\n')
    .map((line) => line.trim().replace(BLOCK_MARKER, ''))
    .join('\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
}

// Did the typed note save as intended? Formatting must match too. A link cannot be
// typed as a link, so text with links is compared without formatting.
export function sameText(stored, typed) {
  if (stored == null) return false;
  if (HAS_LINK.test(String(typed))) return plainText(stored) === plainText(typed);
  return canonical(stored) === canonical(typed);
}

// refs: [{ x, y, left, top }] where x/y are grid units from the API and left/top are
// the element's position in canvas content pixels (viewport-relative rect plus scroll).
// Returns { scale, ox, oy } so that left = ox + x * scale.
export function calibrate(refs, fallbackScale = 8) {
  const usable = (refs || []).filter((ref) => [ref.x, ref.y, ref.left, ref.top].every(Number.isFinite));
  if (!usable.length) return null;
  let scale = null;
  let best = 0;
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dx > best) { best = dx; scale = (b.left - a.left) / (b.x - a.x); }
      if (dy > best) { best = dy; scale = (b.top - a.top) / (b.y - a.y); }
    }
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = fallbackScale;
  const ref = usable[0];
  return { scale, ox: ref.left - ref.x * scale, oy: ref.top - ref.y * scale };
}

export function unitsToContent(calibration, x, y) {
  return { left: calibration.ox + x * calibration.scale, top: calibration.oy + y * calibration.scale };
}

export function contentToUnits(calibration, left, top) {
  return {
    x: Math.round((left - calibration.ox) / calibration.scale),
    y: Math.round((top - calibration.oy) / calibration.scale),
  };
}

// Scroll needed so that a content-space box sits inside the viewport with a margin.
export function scrollDelta(view, box, margin = 60) {
  const delta = { x: 0, y: 0 };
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (box.left < view.scrollLeft + margin) delta.x = box.left - margin - view.scrollLeft;
  else if (right > view.scrollLeft + view.width - margin) delta.x = right + margin - (view.scrollLeft + view.width);
  if (box.top < view.scrollTop + margin) delta.y = box.top - margin - view.scrollTop;
  else if (bottom > view.scrollTop + view.height - margin) delta.y = bottom + margin - (view.scrollTop + view.height);
  return delta;
}

// Points sampled over a footprint to check that nothing already sits there.
export function footprintPoints(box) {
  const inset = 4;
  const xs = [box.left + inset, box.left + box.width / 2, box.left + box.width - inset];
  const ys = [box.top + inset, box.top + box.height / 2, box.top + box.height - inset];
  return xs.flatMap((x) => ys.map((y) => ({ x, y })));
}

// Where to press when dragging an element: a column is grabbed by its title bar,
// anything else just inside its top-left corner, away from resize handles.
export function grabOffset(elementType, width) {
  if (elementType === 'COLUMN') return { x: Math.min(width / 2, 120), y: 18 };
  return { x: 14, y: 14 };
}
