import { describe, it, expect } from 'vitest';
import {
  PROFILES, DEFAULT_PROFILE, mergeProfile, formatRefNumber,
  typeDefOf, isLeafNode, typeColor, nodeTag,
} from '../src/data/schema.js';

const paperModel = { meta: { profileResolved: mergeProfile(PROFILES.paper) } };

describe('schema · mergeProfile', () => {
  it('builds index and sorts types by order', () => {
    const p = mergeProfile(PROFILES.paper);
    expect(p.id).toBe('paper');
    expect(p.types.map((t) => t.id)).toEqual(['theorem', 'proposition', 'lemma', 'bib']);
    expect(p.typeById.theorem.color).toBe('#ff9e64');
    expect(p.defaultType).toBe('theorem');
    expect(p.relationById.cite.numbering).toBe('[n]');
  });
  it('falls back to DEFAULT when null', () => {
    expect(mergeProfile(null).id).toBe(DEFAULT_PROFILE.id);
  });
});

describe('schema · formatRefNumber', () => {
  it('applies numbering templates', () => {
    expect(formatRefNumber('(n)', 3)).toBe('(3)');
    expect(formatRefNumber('[n]', 5)).toBe('[5]');
    expect(formatRefNumber('n', 7)).toBe('7');
  });
  it('handles empty / null', () => {
    expect(formatRefNumber('(n)', '')).toBe('');
    expect(formatRefNumber('n', null)).toBe('');
  });
});

describe('schema · type helpers', () => {
  it('typeDefOf / isLeafNode / typeColor', () => {
    expect(typeDefOf(paperModel, 'lemma').label).toBe('Lemma');
    expect(isLeafNode(paperModel, { type: 'bib' })).toBe(true);
    expect(isLeafNode(paperModel, { type: 'theorem' })).toBe(false);
    expect(typeColor(paperModel, 'theorem')).toBe('#ff9e64');
    expect(typeColor(paperModel, 'unknown')).toBe('#8a8a98');
  });
  it('isLeafNode fallback without profile', () => {
    expect(isLeafNode(null, { type: 'bib' })).toBe(true);
    expect(isLeafNode(undefined, { type: 'theorem' })).toBe(false);
  });
  it('nodeTag formats leaf vs non-leaf', () => {
    expect(nodeTag(paperModel, { type: 'bib', number: '12', id: 'cite:x' })).toBe('[12]');
    expect(nodeTag(paperModel, { type: 'theorem', typeLabel: 'Theorem', number: '1' })).toBe('Theorem 1');
    expect(nodeTag(paperModel, { type: 'theorem', typeLabel: 'Theorem', id: 't' })).toBe('Theorem');
    expect(nodeTag(paperModel, null)).toBe('');
  });
});
