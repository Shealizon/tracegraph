/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationRectsFromRange, annotationTextLengthToBoundary, clampAnnotationChipLeft, markdownTextFromRange, normalizeSelectionForMath } from '../src/view/annotation.js';
import { ModalManager } from '../src/view/modal.js';

const mathRect = { left: 10, right: 310, top: 10, bottom: 50, width: 300, height: 40 };
const fullLineRect = { left: 0, right: 900, top: 10, bottom: 50, width: 900, height: 40 };
const equationNumberRect = { left: 850, right: 880, top: 20, bottom: 40, width: 30, height: 20 };
const textRect = { left: 10, right: 150, top: 70, bottom: 90, width: 140, height: 20 };

describe('annotation geometry next to display math', () => {
  let originalRangeRects;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><span class="katex-display"><span class="katex"><span class="katex-mathml"><math><annotation encoding="application/x-tex">source</annotation></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span id="glyph">FORMULA</span></span><span class="tag">(7)</span></span></span></span><span id="after">If, for some fixed</span></div>';
    document.querySelector('.katex').getClientRects = vi.fn(() => [fullLineRect]);
    document.querySelector('.base').getClientRects = vi.fn(() => [mathRect]);
    document.querySelector('.tag').getClientRects = vi.fn(() => [equationNumberRect]);
    originalRangeRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = vi.fn(() => [textRect]);
  });

  afterEach(() => {
    if (originalRangeRects) Range.prototype.getClientRects = originalRangeRects;
    else delete Range.prototype.getClientRects;
    vi.restoreAllMocks();
  });

  it('does not underline a display formula when the range only touches its trailing boundary', () => {
    const glyph = document.querySelector('#glyph').firstChild;
    const after = document.querySelector('#after').firstChild;
    const range = document.createRange();
    range.setStart(glyph, glyph.nodeValue.length);
    range.setEnd(after, 5);

    expect(annotationRectsFromRange(range, document.querySelector('#root'))).toEqual([textRect]);
  });

  it('still underlines display math when a painted formula character is actually selected', () => {
    const glyph = document.querySelector('#glyph').firstChild;
    const after = document.querySelector('#after').firstChild;
    const range = document.createRange();
    range.setStart(glyph, 2);
    range.setEnd(after, 5);

    expect(annotationRectsFromRange(range, document.querySelector('#root'))).toEqual([mathRect, textRect]);
  });

  it('uses only painted formula rows and excludes the full line and equation number', () => {
    const formula = document.querySelector('.katex-display');
    const range = document.createRange();
    range.selectNode(formula);

    expect(annotationRectsFromRange(range, document.querySelector('#root'))).toEqual([mathRect]);
  });

  it('merges multiple KaTeX base fragments into one bottom-aligned formula underline', () => {
    const root = document.querySelector('#root');
    const html = root.querySelector('.katex-html');
    const secondBase = document.createElement('span');
    secondBase.className = 'base';
    secondBase.textContent = 'TAIL';
    html.insertBefore(secondBase, html.querySelector('.tag'));
    const tailRect = { left: 305, right: 390, top: 22, bottom: 42, width: 85, height: 20 };
    secondBase.getClientRects = vi.fn(() => [tailRect]);
    const formula = root.querySelector('.katex-display');
    const range = document.createRange();
    range.selectNode(formula);

    expect(annotationRectsFromRange(range, root)).toEqual([{
      left: 10, right: 390, top: 10, bottom: 50, width: 380, height: 40,
    }]);
  });

  it('keeps a selection that starts inside ordinary text', () => {
    const after = document.querySelector('#after').firstChild;
    const range = document.createRange();
    range.setStart(after, 4);
    range.setEnd(after, 10);

    expect(annotationRectsFromRange(range, document.querySelector('#root'))).toEqual([textRect]);
  });

  it('rebuilds a saved text span from the text after the formula, not from the formula boundary', () => {
    const body = document.createElement('div');
    body.innerHTML = '<div class="statement"><span class="katex-display"><span class="katex"><span class="katex-mathml">source</span><span class="katex-html" aria-hidden="true"><span>FORMULA</span></span></span></span><span id="saved-after">If, for some fixed</span></div>';
    const after = body.querySelector('#saved-after').firstChild;

    const range = ModalManager.prototype._rangeFromMember.call({}, body, {
      section: 'statement', start: 0, end: 5, offsetMode: 'visible',
    });

    expect(range.startContainer).toBe(after);
    expect(range.startOffset).toBe(0);
    expect(range.endContainer).toBe(after);
    expect(range.endOffset).toBe(5);
  });

  it('copies a display formula as Markdown source instead of rendered Unicode', () => {
    const root = document.querySelector('#root');
    const formula = root.querySelector('.katex-display');
    const range = document.createRange();
    range.selectNode(formula);

    expect(markdownTextFromRange(range)).toBe('$$source$$');
  });

  it('expands a partial formula selection to the complete Markdown formula', () => {
    const root = document.querySelector('#root');
    const glyph = root.querySelector('#glyph').firstChild;
    const selection = window.getSelection();
    const partial = document.createRange();
    partial.setStart(glyph, 1);
    partial.setEnd(glyph, 4);
    selection.removeAllRanges();
    selection.addRange(partial);

    normalizeSelectionForMath(selection, root);

    expect(markdownTextFromRange(selection.getRangeAt(0))).toBe('$$source$$');
  });

  it('stores and rebuilds a mixed text-and-inline-formula span without losing the formula', () => {
    const body = document.createElement('div');
    body.innerHTML = '<div class="statement"><span id="before">Let </span><span class="katex"><span class="katex-mathml"><annotation encoding="application/x-tex">x+1</annotation></span><span class="katex-html" aria-hidden="true"><span>𝑥+1</span></span></span><span id="mixed-after"> solve</span></div>';
    const statement = body.querySelector('.statement');
    const before = body.querySelector('#before').firstChild;
    const after = body.querySelector('#mixed-after').firstChild;
    const selected = document.createRange();
    selected.setStart(before, 0);
    selected.setEnd(after, after.nodeValue.length);
    const start = annotationTextLengthToBoundary(statement, selected.startContainer, selected.startOffset);
    const end = annotationTextLengthToBoundary(statement, selected.endContainer, selected.endOffset);
    const text = markdownTextFromRange(selected);

    expect({ start, end, text }).toEqual({ start: 0, end: 15, text: 'Let $x+1$ solve' });

    const rebuilt = ModalManager.prototype._rangeFromMember.call({}, body, {
      section: 'statement', start, end, text, offsetMode: 'annotation-md',
    });
    expect(markdownTextFromRange(rebuilt)).toBe('Let $x+1$ solve');
  });

  it('allows a formula-only span to have a non-empty Markdown offset range', () => {
    const root = document.querySelector('#root');
    const formula = root.querySelector('.katex-display');
    const selected = document.createRange();
    selected.selectNode(formula);

    const start = annotationTextLengthToBoundary(root, selected.startContainer, selected.startOffset);
    const end = annotationTextLengthToBoundary(root, selected.endContainer, selected.endOffset);

    expect(end - start).toBe('$$source$$'.length);
    const rebuilt = ModalManager.prototype._rangeFromMember.call({}, { querySelector: () => root }, {
      section: 'statement', start, end, offsetMode: 'annotation-md',
    });
    expect(markdownTextFromRange(rebuilt)).toBe('$$source$$');
  });

  it('keeps an annotation chip inside the visible page width', () => {
    const container = document.createElement('div');
    const chip = document.createElement('div');
    Object.defineProperties(container, {
      clientWidth: { value: 200 },
      scrollLeft: { value: 30, writable: true },
    });
    Object.defineProperty(chip, 'offsetWidth', { value: 50 });

    expect(clampAnnotationChipLeft(container, chip, 400)).toBe(176);
    expect(clampAnnotationChipLeft(container, chip, -20)).toBe(34);
  });
});
