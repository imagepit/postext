import { describe, it, expect } from 'vitest';
import { buildDocument } from '../../../pipeline/index.js';
import { renderToHtml } from '../../../html-backend/html-backend.js';
import { codeFenceSettings, codePrefixColumn } from '../../../pipeline/code/codeLines.js';
import { resolveCodeStyleConfig, stripCodeStyleDefaults } from '../../../defaults/text/codeStyle.js';
import { resolveBodyTextConfig } from '../../../defaults/text/bodyText.js';
import { collectConfigWarnings } from '../../../checks/configWarnings.js';
import type { PostextConfig } from '../../../types.js';
import type { VDTBlock, VDTDocument, VDTLine } from '../../../vdt.js';
import { textOfHtml } from '../../htmlText.js';

// CORE-230: the kinds of line a fence marks (`add`, `del`, `focus`, `error`,
// `warning`) and the `+` / `-` prefix column. The stub font: 7 px a
// character, a space 4 px.
class StubCtx {
  font = '';
  measureText(s: string): { width: number } {
    let w = 0;
    for (const c of s) w += c === ' ' ? 4 : 7;
    return { width: w };
  }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
  getContext(): StubCtx {
    return new StubCtx();
  }
};

const pt = (value: number) => ({ value, unit: 'pt' as const });
const hex = (h: string) => ({ hex: h, model: 'hex' as const });
const DIFF: NonNullable<PostextConfig['codeStyle']>['lineKinds'] = {
  add: { background: hex('#e6f4ea'), marker: hex('#1a7f37'), prefix: '+', prefixColor: hex('#1a7f37') },
  del: { background: hex('#fdecea'), marker: hex('#cf222e'), prefix: '-', prefixColor: hex('#cf222e') },
  focus: { bold: true },
  error: { background: hex('#ffebe9') },
  warning: { background: hex('#fff8c5') },
};
const config = (codeStyle: PostextConfig['codeStyle'] = {}, width = 600): PostextConfig => ({
  page: { dpi: 72, width: pt(width), height: pt(600), margins: { top: pt(20), bottom: pt(20), left: pt(20), right: pt(20) } },
  layout: { layoutType: 'single' },
  header: { elements: [] },
  footer: { elements: [] },
  bodyText: { fontSize: pt(20), lineHeight: { value: 1.5, unit: 'em' }, firstLineIndent: pt(0), hyphenation: { enabled: false } },
  codeStyle,
});
const build = (fence: string, src: string[], cs: PostextConfig['codeStyle'] = { lineKinds: DIFF }, width?: number): VDTDocument =>
  buildDocument({ markdown: ['```' + fence, ...src, '```'].join('\n') }, config(cs, width));
const codeLines = (doc: VDTDocument): VDTLine[] => doc.blocks.filter((b) => b.type === 'code').flatMap((b) => b.lines);
const frame = (doc: VDTDocument): VDTBlock => doc.blocks.find((b) => b.type === 'callout')!;
const boxes = (doc: VDTDocument, color: string) =>
  frame(doc).designOverlay!.blocks.filter((b) => b.kind === 'box' && b.box.backgroundColor === color);
const resolved = (cs: PostextConfig['codeStyle']) => resolveCodeStyleConfig(cs, resolveBodyTextConfig({ fontSize: pt(20) }));

describe('fence attributes for the kinds of line', () => {
  it('reads add / del / focus / error / warning like highlight; a line marked twice takes the first of del, error, warning, add, focus', () => {
    const block = { code: { attrs: { add: '1-2', del: '2', focus: '3', error: '4', warning: '4,5' } } } as never;
    const set = codeFenceSettings(block, resolved({}));
    expect([...set.kinds.entries()].sort()).toEqual([[1, 'add'], [2, 'del'], [3, 'focus'], [4, 'error'], [5, 'warning']]);
  });

  it('builds no prefix column when no marked line has a prefix', () => {
    const block = { code: { attrs: { focus: '1' } } } as never;
    const cs = resolved({ lineKinds: DIFF });
    expect(codePrefixColumn(codeFenceSettings(block, cs), cs, 2)).toBeUndefined();
  });
});

describe('the prefix column', () => {
  it('sets "+ " and "- " before the marked lines and a blank of the same width before the others, so the indents line up', () => {
    const doc = build(' {add="3" del="2"}', ['int main() {', '  printf("Hello");', '  printf("World");', '}']);
    const lines = codeLines(doc);
    const lead = lines.map((l) => l.segments![0]!);
    expect(lead.map((s) => s.text)).toEqual(['', '- ', '+ ', '']);
    // One width for all: "+ " is 7 + 4 px.
    for (const s of lead) expect(s.width).toBeCloseTo(11, 5);
    expect(lead[1]!.color).toBe('#cf222e');
    expect(lead[2]!.color).toBe('#1a7f37');
    // Every line's code starts at the same x, after the column; its indent stays.
    const codeX = lines.map((l) => l.bbox.x + l.segments![0]!.width);
    expect(new Set(codeX.map((x) => x.toFixed(3))).size).toBe(1);
    expect(lines[1]!.text).toBe('  printf("Hello");');
    // The prefix is a leader: out of the line's text and the copied listing.
    for (const s of lead) expect(s.inserted).toBe(true);
    const html = renderToHtml(doc);
    expect(textOfHtml(html)).not.toMatch(/[+-] {1,2}printf/);
  });

  it('puts the column after the line numbers', () => {
    const doc = build(' {lineNumbers add="1"}', ['a();', 'b();']);
    const [first] = codeLines(doc);
    const numbers = doc.pages[0]!.lineNumbers!.blocks.filter((b) => b.kind === 'text');
    const numberRight = numbers[0]!.bbox.x + numbers[0]!.bbox.width;
    const frameX = frame(doc).bbox.x;
    expect(numberRight).toBeLessThan(first!.bbox.x + frameX + 0.01);
    expect(first!.segments![0]!.text).toBe('+ ');
  });

  it('keeps a wrapped line\'s continuation under its code, past a blank prefix', () => {
    const long = 'w'.repeat(60);
    const doc = build(' {add="1"}', [long, 'end'], { lineKinds: DIFF, wrapMarker: '' }, 300);
    const lines = codeLines(doc);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]!.segments![0]!.text).toBe('+ ');
    expect(lines[1]!.codeLine!.continued).toBe(true);
    expect(lines[1]!.codeLine!.kind).toBe('add');
    expect(lines[1]!.segments![0]!.text).toBe('');
    expect(lines[1]!.segments![0]!.width).toBeCloseTo(11, 5);
  });

  it('sets no column without lineKinds: the listing is as before', () => {
    const doc = build(' {add="1"}', ['a();'], {});
    expect(codeLines(doc)[0]!.segments![0]!.text).toBe('a();');
  });
});

describe('the band of a kind', () => {
  it('paints the kind\'s band and a rule at its left edge; highlight keeps its tint', () => {
    const doc = build(' {add="1" del="2" highlight="3"}', ['a', 'b', 'c'], { lineKinds: DIFF, highlightBackground: hex('#eeeeee') });
    const lines = codeLines(doc);
    const add = boxes(doc, '#e6f4ea');
    const del = boxes(doc, '#fdecea');
    expect(add).toHaveLength(1);
    expect(del).toHaveLength(1);
    expect(add[0]!.bbox.y).toBeCloseTo(lines[0]!.bbox.y, 5);
    expect(del[0]!.bbox.y).toBeCloseTo(lines[1]!.bbox.y, 5);
    const rule = boxes(doc, '#1a7f37');
    expect(rule).toHaveLength(1);
    expect(rule[0]!.bbox.x).toBeCloseTo(add[0]!.bbox.x, 5);
    expect(rule[0]!.bbox.width).toBeCloseTo(1.5, 5);
    expect(boxes(doc, '#eeeeee')).toHaveLength(1);
  });

  it('leaves the band off in a dark callout too: the listing sits on its background', () => {
    // The listing box has no background of its own (as in a terminal design).
    const cfg = config({ lineKinds: DIFF, backgroundEnabled: false });
    cfg.calloutStyles = [{ id: 'terminal', background: hex('#262626') }] as never;
    const doc = buildDocument({ markdown: [':::callout{type="terminal"}', '', '```console {add="1"}', '$ git init', '```', '', ':::'].join('\n') }, cfg);
    const overlays = doc.blocks.filter((b) => b.type === 'callout').flatMap((b) => b.designOverlay?.blocks ?? []);
    expect(overlays.some((b) => b.kind === 'box' && b.box.backgroundColor === '#e6f4ea')).toBe(false);
    expect(overlays.some((b) => b.kind === 'box' && b.box.backgroundColor === '#1a7f37')).toBe(true);
  });

  it('leaves the band off on a dark box, keeping the rule and the prefix, so light text stays readable', () => {
    const doc = build(' {add="1"}', ['a'], { lineKinds: DIFF, background: hex('#1e1e1e') });
    expect(boxes(doc, '#e6f4ea')).toHaveLength(0);
    expect(boxes(doc, '#1a7f37')).toHaveLength(1);
    expect(codeLines(doc)[0]!.segments![0]!.text).toBe('+ ');
  });

  it('sets a focus line in bold, with no band', () => {
    const doc = build(' {focus="1"}', ['a();', 'b();']);
    const [focus, plain] = codeLines(doc);
    expect(focus!.segments!.filter((s) => s.kind === 'text' && s.text).every((s) => s.bold)).toBe(true);
    expect(plain!.segments!.some((s) => s.bold)).toBe(false);
  });

  it('paints nothing for a kind the config leaves unset', () => {
    const doc = build(' {error="1"}', ['a();'], { lineKinds: { add: DIFF.add } });
    expect(frame(doc).designOverlay!.blocks.filter((b) => b.kind === 'box' && b.bbox.height < 40)).toHaveLength(0);
  });
});

describe('codeStyle.lineKinds in the config', () => {
  it('raises no unknown-key warning, and keeps what is set when defaults are stripped', () => {
    const warnings = collectConfigWarnings(config({ lineKinds: DIFF }));
    expect(warnings.filter((w) => /lineKinds/.test(JSON.stringify(w)))).toEqual([]);
    const bad = collectConfigWarnings(config({ lineKinds: { add: { colour: hex('#000000') } } as never }));
    expect(bad.some((w) => /codeStyle\.lineKinds\.add/.test(JSON.stringify(w)))).toBe(true);
    expect(stripCodeStyleDefaults({ lineKinds: { add: { prefix: '+' }, del: {} } })).toEqual({ lineKinds: { add: { prefix: '+' } } });
  });
});
