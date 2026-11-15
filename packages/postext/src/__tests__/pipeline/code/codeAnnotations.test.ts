import { describe, it, expect } from 'vitest';
import { buildDocument } from '../../../pipeline/index.js';
import type { PostextConfig } from '../../../types.js';
import type { VDTLine, VDTLineSegment } from '../../../vdt.js';

// CORE-213: `codeStyle.annotations` and `codeStyle.highlightBold`. The stub
// font: 7 px a character, a space 4 px.
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
const config = (codeStyle: PostextConfig['codeStyle'] = {}): PostextConfig => ({
  page: { dpi: 72, width: pt(600), height: pt(600), margins: { top: pt(20), bottom: pt(20), left: pt(20), right: pt(20) } },
  layout: { layoutType: 'single' },
  header: { elements: [] },
  footer: { elements: [] },
  bodyText: { fontSize: pt(20), lineHeight: { value: 1.5, unit: 'em' }, firstLineIndent: pt(0), hyphenation: { enabled: false } },
  codeStyle,
});
const linesOf = (src: string[], cs: PostextConfig['codeStyle'] = {}, fenceAttrs = ''): VDTLine[] => {
  const doc = buildDocument({ markdown: ['```' + fenceAttrs, ...src, '```'].join('\n') }, config(cs));
  return doc.blocks.filter((b) => b.type === 'code').flatMap((b) => b.lines);
};
const segs = (l: VDTLine): VDTLineSegment[] => l.segments ?? [];
const strip = (l: VDTLine[]) => l.map((x) => (x.segments ?? []).map(({ text, fontString, bold, color, width }) => ({ text, fontString, bold, color, width })));

describe('codeStyle.annotations', () => {
  it('sets a marker as an arrow and its note in bold, without brackets', () => {
    const [line] = linesOf(['x = 1 <--[the note] y'], { annotations: true });
    expect(line!.text).toBe('x = 1 ⟵the note y');
    const arrow = segs(line!).find((s) => s.text.includes('⟵'))!;
    expect(arrow.bold).toBeUndefined();
    const note = segs(line!).find((s) => s.text === 'the note')!;
    expect(note.bold).toBe(true);
    expect(line!.text).not.toMatch(/[\[\]]|<--/);
    expect(line!.bbox.width).toBeCloseTo(line!.text.split('').reduce((w, c) => w + (c === ' ' ? 4 : 7), 0), 5);
  });

  it('gives a bolded run the code colour, not the body bold colour', () => {
    const cs = { annotations: true, highlightBold: true, color: { hex: '#fafafa', model: 'hex' as const } };
    const [note, hl] = linesOf(['// <--[the note]', 'b();'], cs, ' {highlight="2"}');
    expect(segs(note!).find((s) => s.text === 'the note')!.color).toBe('#fafafa');
    expect(segs(hl!).filter((s) => s.kind === 'text').every((s) => s.color === '#fafafa')).toBe(true);
  });
  it('knows the three markers and several to a line', () => {
    const lines = linesOf(['v--[down]', '^--[up]', 'a <--[one] b ^--[two]'], { annotations: true });
    expect(lines.map((l) => l.text)).toEqual(['⬐down', '⬑up', 'a ⟵one b ⬑two']);
    const bolds = segs(lines[2]!).filter((s) => s.bold).map((s) => s.text);
    expect(bolds).toEqual(['one', 'two']);
  });

  it('leaves what is no annotation alone', () => {
    const src = ['i--', 'v--;', 'x <-- y', '<!-- c -->', 'a-->b', 'f(<--[ open', 'n^-- [x]'];
    expect(linesOf(src, { annotations: true }).map((l) => l.text)).toEqual(src);
    expect(strip(linesOf(src, { annotations: true }))).toEqual(strip(linesOf(src)));
  });

  it('keeps the token colours around an annotation', () => {
    const [plain] = linesOf(['const a = 1; // c'], {}, ' js');
    const [ann] = linesOf(['const a = 1; <--[n]'], { annotations: true }, ' js');
    expect(segs(ann!)[0]!.color).toBe(segs(plain!)[0]!.color);
    expect(segs(ann!)[0]!.text).toBe('const');
  });
});

describe('codeStyle.highlightBold', () => {
  it('sets the highlighted lines bold, no others', () => {
    const lines = linesOf(['a();', 'b();', 'c();'], { highlightBold: true }, ' js {highlight="2"}');
    expect(lines.map((l) => segs(l).every((s) => s.kind !== 'text' || s.bold === true))).toEqual([false, true, false]);
    expect(segs(lines[0]!).some((s) => s.bold)).toBe(false);
    expect(segs(lines[1]!).every((s) => s.fontString === segs(lines[1]!)[0]!.fontString || s.bold)).toBe(true);
  });
});

describe('defaults', () => {
  it('both flags off: the runs are as before, whatever the text holds', () => {
    const src = ['a <--[note] b', 'v--[x]', 'c();'];
    const attrs = ' js {highlight="1,3"}';
    const base = strip(linesOf(src, {}, attrs));
    expect(strip(linesOf(src, { annotations: false, highlightBold: false }, attrs))).toEqual(base);
    expect(linesOf(src, {}, attrs)[0]!.text).toBe(src[0]);
    expect(base.flat().some((s) => s.bold)).toBe(false);
  });
});
