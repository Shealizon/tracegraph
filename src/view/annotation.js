// Shared helpers for annotations that are anchored to rendered paper text.
// KaTeX emits both a hidden MathML tree and a visible HTML tree; the hidden
// tree must never contribute to annotation offsets.

export function isHiddenAnnotationNode(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest?.('.katex-mathml, [aria-hidden="true"]');
}

export function removeHiddenAnnotationNodes(root) {
  root?.querySelectorAll?.('.katex-mathml, [aria-hidden="true"]').forEach((el) => el.remove());
  return root;
}

export function visibleTextFromRange(range) {
  if (!range) return '';
  const fragment = removeHiddenAnnotationNodes(range.cloneContents());
  return fragment.textContent || '';
}

export function visibleTextLengthToBoundary(container, node, offset) {
  if (!container || !node || !container.contains(node)) return 0;
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return visibleTextFromRange(range).length;
}

export function forEachVisibleTextNode(container, visit) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (isHiddenAnnotationNode(node)) continue;
    visit(node);
  }
}

// Treat rendered math as an atomic selectable element. In display mode both
// .katex-display and its .katex child can occupy the full line. KaTeX's .base
// elements are the actual painted formula rows; the sibling .tag is the
// equation number and deliberately does not belong to annotation geometry.
function mathVisualNodes(atom) {
  const katex = atom?.matches?.('.katex') ? atom : atom?.querySelector?.('.katex');
  const html = katex?.querySelector?.('.katex-html');
  if (!html) return katex ? [katex] : atom ? [atom] : [];

  const bases = [...html.querySelectorAll('.base')]
    .filter((el) => !el.closest('.tag'));
  if (bases.length) return bases;

  // Be defensive around older/different KaTeX output while still excluding
  // equation numbers. Direct painted children are narrower than .katex.
  const painted = [...html.children].filter((el) => !el.matches('.tag'));
  return painted.length ? painted : [html];
}

export function mathAnnotationAtoms(root) {
  const atoms = [];
  root?.querySelectorAll?.('.katex-display').forEach((el) => {
    const visuals = mathVisualNodes(el);
    atoms.push({ node: el, visual: visuals[0], visuals });
  });
  root?.querySelectorAll?.('.katex').forEach((el) => {
    if (!el.closest('.katex-display')) {
      const visuals = mathVisualNodes(el);
      atoms.push({ node: el, visual: visuals[0], visuals });
    }
  });
  return atoms;
}

export function mathMarkdownSource(atom) {
  const katex = atom?.matches?.('.katex') ? atom : atom?.querySelector?.('.katex');
  const annotation = katex?.querySelector?.('annotation[encoding="application/x-tex"]');
  const source = annotation?.textContent || '';
  if (!source) return '';
  const display = !!(atom?.matches?.('.katex-display') || atom?.closest?.('.katex-display, .math-display'));
  return display ? `$$${source}$$` : `$${source}$`;
}

// Copy the selected content as Markdown source. Rendered KaTeX contains both
// MathML and painted HTML; replacing the outer .katex node first avoids both
// Unicode output and duplicated formula text.
export function markdownTextFromRange(range) {
  if (!range) return '';
  const fragment = range.cloneContents();
  fragment.querySelectorAll?.('.katex').forEach((katex) => {
    const source = mathMarkdownSource(katex);
    katex.replaceWith(document.createTextNode(source || katex.textContent || ''));
  });
  removeHiddenAnnotationNodes(fragment);
  return (fragment.textContent || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function annotationUnits(root) {
  const units = mathAnnotationAtoms(root).map((atom) => ({
    node: atom.node,
    visual: atom.visual,
    visuals: atom.visuals,
    kind: 'math',
    text: mathMarkdownSource(atom.node),
  }));
  forEachVisibleTextNode(root, (node) => {
    if (!node.parentElement?.closest?.('.katex')) {
      units.push({ node, visual: node, kind: 'text', text: node.nodeValue || '' });
    }
  });
  units.sort((a, b) => {
    if (a.node === b.node) return 0;
    return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  return units;
}

function nodeEndOffset(node) {
  return node.nodeType === Node.TEXT_NODE ? (node.nodeValue?.length || 0) : node.childNodes.length;
}

function boundaryAround(node, after) {
  const parent = node?.parentNode;
  if (!parent) return null;
  const index = Array.prototype.indexOf.call(parent.childNodes, node);
  return { node: parent, offset: index + (after ? 1 : 0) };
}

// Offset model used by new span members: normal text contributes its character
// length and each formula contributes the length of its Markdown source.
export function annotationTextLengthToBoundary(root, container, offset) {
  if (!root || !container || !root.contains(container)) return 0;
  let total = 0;
  for (const unit of annotationUnits(root)) {
    const endOffset = nodeEndOffset(unit.node);
    const afterEnd = comparePoints(container, offset, unit.node, endOffset);
    if (afterEnd >= 0) {
      total += unit.text.length;
      continue;
    }
    const beforeStart = comparePoints(container, offset, unit.node, 0);
    if (beforeStart <= 0) break;
    if (unit.kind === 'text' && container === unit.node) {
      total += Math.max(0, Math.min(unit.text.length, offset));
    }
    break;
  }
  return total;
}

export function annotationBoundaryAtOffset(root, rawOffset, bias = 'forward') {
  const target = Math.max(0, Number(rawOffset) || 0);
  let acc = 0;
  let last = null;
  for (const unit of annotationUnits(root)) {
    const length = unit.text.length;
    if (!length) continue;
    const end = acc + length;
    const ownsBoundary = bias === 'backward' ? target <= end : target < end;
    if (ownsBoundary) {
      if (unit.kind === 'text') {
        return { node: unit.node, offset: Math.max(0, Math.min(length, target - acc)) };
      }
      if (target <= acc) return boundaryAround(unit.node, false);
      return boundaryAround(unit.node, bias === 'backward');
    }
    last = unit.kind === 'text'
      ? { node: unit.node, offset: length }
      : boundaryAround(unit.node, true);
    acc = end;
  }
  return last;
}

// `Range.intersectsNode()` treats a range that merely touches a node boundary
// as intersecting it. That is especially surprising for a block-level
// `.katex-display`: selecting the paragraph immediately after a display can
// therefore make the display look selected too. Compare collapsed boundary
// ranges instead and require a *strict* overlap.
function comparePoints(containerA, offsetA, containerB, offsetB) {
  const a = document.createRange();
  const b = document.createRange();
  a.setStart(containerA, offsetA); a.collapse(true);
  b.setStart(containerB, offsetB); b.collapse(true);
  return a.compareBoundaryPoints(Range.START_TO_START, b);
}

function strictlyOverlapsNode(range, node) {
  try {
    // Element boundary offsets count child nodes, while text boundary offsets
    // count characters. Using childNodes.length for text collapses its end to
    // offset 0 and makes overlap checks depend on which side was dragged.
    const endOffset = nodeEndOffset(node);
    const endsAfterStart = comparePoints(range.endContainer, range.endOffset, node, 0) > 0;
    const startsBeforeEnd = comparePoints(range.startContainer, range.startOffset, node, endOffset) < 0;
    return endsAfterStart && startsBeforeEnd;
  } catch {
    return false;
  }
}

// KaTeX's painted HTML tree is marked aria-hidden because MathML is exposed to
// assistive technology. For visual overlap it is nevertheless the authoritative
// tree. Requiring overlap with an actual painted text node avoids treating the
// empty DOM boundary after a display formula as selected.
function overlapsRenderedMath(range, atom) {
  for (const visual of mathVisualNodes(atom)) {
    const walker = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue?.length && strictlyOverlapsNode(range, node)) return true;
    }
  }
  return false;
}

export function normalizeSelectionForMath(selection, root) {
  if (!selection?.rangeCount || !root) return null;
  const range = selection.getRangeAt(0);
  const anchor = selection.anchorNode;
  const anchorOffset = selection.anchorOffset;
  const focus = selection.focusNode;
  const focusOffset = selection.focusOffset;
  const atoms = mathAnnotationAtoms(root);
  let changed = false;
  for (const { node: atom } of atoms) {
    // Do not expand an atom when the selection only ends immediately before
    // it or starts immediately after it. The native intersectsNode() check is
    // not strict enough for that boundary case.
    if (!overlapsRenderedMath(range, atom)) continue;
    try {
      const startsInside = comparePoints(range.startContainer, range.startOffset, atom, 0) > 0;
      const endsInside = comparePoints(range.endContainer, range.endOffset, atom, atom.childNodes.length) < 0;
      if (startsInside) { range.setStartBefore(atom); changed = true; }
      if (endsInside) { range.setEndAfter(atom); changed = true; }
    } catch {
      // A detached/invalid selection can occur during a fast page transition.
    }
  }
  if (!changed) return range;

  // Keep the user's drag direction while replacing the native partial range.
  let forward = true;
  try {
    const a = document.createRange(); a.setStart(anchor, anchorOffset); a.collapse(true);
    const f = document.createRange(); f.setStart(focus, focusOffset); f.collapse(true);
    forward = a.compareBoundaryPoints(Range.START_TO_START, f) <= 0;
  } catch { /* use the normal forward order */ }
  selection.removeAllRanges();
  if (selection.setBaseAndExtent) {
    if (forward) selection.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset);
    else selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
  } else selection.addRange(range);
  return range;
}

// A single rendered formula can contain several sibling .base elements even
// when it occupies only one visual line. They are TeX layout fragments, not
// annotation lines. Collapse all painted fragments into one bottom-aligned
// geometry so a display formula always gets one continuous underline. For a
// stacked/multiline TeX box this intentionally falls back to its bottom edge.
function formulaUnderlineRect(visuals) {
  const painted = [];
  for (const visual of visuals) {
    if (visual?.getClientRects) painted.push(...visual.getClientRects());
  }
  const rects = painted.filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

// Build annotation geometry from the actual selected units. In particular,
// never call getClientRects() on a range containing a block-level
// .katex-display wrapper, since that wrapper may report the full text width.
export function annotationRectsFromRange(range, root) {
  if (!range || !root) return [];
  const units = mathAnnotationAtoms(root).map((atom) => ({ ...atom, kind: 'math' }));
  forEachVisibleTextNode(root, (node) => {
    if (!node.parentElement?.closest?.('.katex')) units.push({ node, visual: node, kind: 'text' });
  });
  units.sort((a, b) => {
    if (a.node === b.node) return 0;
    return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  const rects = [];
  for (const unit of units) {
    let intersects = false;
    // A range that ends immediately before (or starts immediately after) a
    // display formula must not draw a marker for that formula. The native
    // intersectsNode() includes those touching-boundary cases.
    try {
      intersects = unit.kind === 'math'
        ? overlapsRenderedMath(range, unit.node)
        : strictlyOverlapsNode(range, unit.node);
    } catch { continue; }
    if (!intersects) continue;
    if (unit.kind === 'math') {
      const formulaRect = formulaUnderlineRect(unit.visuals || [unit.visual]);
      if (formulaRect) rects.push(formulaRect);
      continue;
    }
    const length = unit.node.nodeValue?.length || 0;
    let start = 0;
    let end = length;
    if (range.startContainer === unit.node) start = range.startOffset;
    if (range.endContainer === unit.node) end = range.endOffset;
    if (end <= start) continue;
    const part = document.createRange();
    try {
      part.setStart(unit.node, start);
      part.setEnd(unit.node, end);
      rects.push(...part.getClientRects());
    } catch { /* selection changed while geometry was being read */ }
  }
  return rects;
}

// Absolute annotation chips otherwise enlarge scrollWidth when they are
// placed after a range near the right edge. Keep them in the currently visible
// horizontal page area; callers append the chip first so offsetWidth is known.
export function clampAnnotationChipLeft(container, chip, desiredLeft, padding = 4) {
  const scrollLeft = Number(container?.scrollLeft) || 0;
  const min = scrollLeft + padding;
  const width = Number(container?.clientWidth) || 0;
  const chipWidth = Number(chip?.offsetWidth) || 0;
  const max = Math.max(min, scrollLeft + width - chipWidth - padding);
  return Math.max(min, Math.min(Number(desiredLeft) || 0, max));
}

export function groupAnnotationRects(rectList) {
  const rects = [...rectList]
    .filter((rect) => rect.width > 1 && rect.height > 1)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const groups = [];
  for (const rect of rects) {
    const previous = groups.at(-1);
    const sameLine = previous && Math.abs(previous.top - rect.top) <= Math.max(2, Math.min(previous.height, rect.height) * 0.35);
    if (!sameLine) {
      groups.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
      continue;
    }
    previous.left = Math.min(previous.left, rect.left);
    previous.right = Math.max(previous.right, rect.right);
    previous.top = Math.min(previous.top, rect.top);
    previous.bottom = Math.max(previous.bottom, rect.bottom);
    previous.width = previous.right - previous.left;
    previous.height = previous.bottom - previous.top;
  }
  return groups;
}
