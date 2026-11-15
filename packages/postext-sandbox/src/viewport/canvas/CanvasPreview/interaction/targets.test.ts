import { describe, expect, it } from 'vitest';
import type { SourceElement } from 'postext';
import type { PageSelection } from '../../../../selection/pageSelection.js';
import { contentSelectionLeads } from './targets.js';

const el = (level: SourceElement['level'], source: SourceElement['source']): SourceElement => ({ level, id: `e-${level}`, source });
const md = { kind: 'markdown', start: 10, end: 20 } as const;
const picture = el('resource', { kind: 'resource', resourceId: 'outline-img-55036aff' });
const figure = el('block', md);
const sel = (chain: SourceElement[], level = 0): PageSelection => ({ pageIndex: 3, chain, level, point: { x: 0.4, y: 0.8 }, origin: 'page' });

// IMAGEPIT CORE-214: in Content mode a click on a picture opens its resource
// (the Resources panel), not the caret at its `::resource` line.
describe('contentSelectionLeads', () => {
  it('carries out a click on a picture', () => {
    expect(contentSelectionLeads(sel([picture, figure]))).toBe(true);
  });

  it('leaves a click on words to the caret, as before', () => {
    expect(contentSelectionLeads(sel([el('text', md), figure]))).toBe(false);
  });

  it('keeps the levels it carried out before', () => {
    expect(contentSelectionLeads(sel([el('design', { kind: 'config', path: 'header.elements.0' })]))).toBe(true);
    expect(contentSelectionLeads(sel([el('label', { kind: 'resource', resourceId: 'fig', anchor: 'a' })]))).toBe(true);
    expect(contentSelectionLeads(sel([el('text', { kind: 'attr', name: 'title', start: 1, end: 4 })]))).toBe(true);
  });

  it('carries out any level picked above the innermost', () => {
    expect(contentSelectionLeads(sel([el('text', md), figure], 1))).toBe(true);
  });
});
