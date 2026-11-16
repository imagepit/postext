// Postext の章の Markdown を Outline の Markdown へ戻す。convert.ts の逆。入出力を持たない純粋関数。
// 取り込みで落とした記述（先頭の yaml、差し込み記法）は、元の Outline 本文を渡せばそこから補う。
// 往復の約束: convertOutlineMarkdown(toOutlineMarkdown(convert(X)).markdown) は convert(X) と同じ本文・画像・表になる。

import { bodyOf } from "./provenance";

export interface ReverseOptions {
  /** 書籍の resources。::resource の画像と表をここから引く。 */
  resources: readonly Record<string, unknown>[];
  /** 書き戻し先の Outline の現在の本文。先頭の yaml と差し込み記法をここから戻す。 */
  original?: string;
}

/** Outline へ添付してから本文の placeholder を置き換える必要がある画像（Postext で足した画像）。 */
export interface PendingImage {
  resourceId: string;
  /** 本文に入れた仮の参照。添付の後、`/api/attachments.redirect?id=<添付ID>` に置き換える。 */
  placeholder: string;
}

export interface ReverseResult {
  /** 先頭の `# 題` の題。なければ undefined。 */
  title?: string;
  markdown: string;
  images: PendingImage[];
  warnings: string[];
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*(.*)$/;
const DIRECTIVE_OPEN = /^:::\s*[A-Za-z]/;
const DIRECTIVE_CLOSE = /^:::\s*$/;
const CALLOUT = /^:::callout\{(.*)\}\s*$/;
const RESOURCE = /^::resource\{(.*)\}\s*$/;
const BOLD_ONLY = /^\*\*(.+)\*\*$/;
const OUTLINE_IMAGE = /^outline-img-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/;
const TEMPLATE_ONLY = /^\s*\{\{[^}]*\}\}\s*$/;
const BACK_TO_OUTLINE: Record<string, string> = { note: "note", syntax: "syntax", caution: "caution" };

/** `key="v" key='v' key=v` を読む。順序を保つ。 */
export function parseAttrs(src: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([A-Za-z][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|[^\s}]+)/g;
  for (const m of src.matchAll(re)) out.push([m[1]!, m[3] ?? m[4] ?? m[2]!]);
  return out;
}

const attr = (attrs: [string, string][], key: string): string | undefined => attrs.find(([k]) => k === key)?.[1];

/** convert.ts の attrValue の逆。全角に置き換えた波括弧と引用符を戻す。 */
const plain = (v: string): string => v.replace(/｛/g, "{").replace(/｝/g, "}");

const isFence = (line: string): RegExpExecArray | null => {
  const m = FENCE_OPEN.exec(line);
  return m && !(m[2]![0] === "`" && m[3]!.includes("`")) ? m : null;
};

/** i 行目のフェンスの閉じの行番号。なければ lines.length。 */
function fenceEnd(lines: string[], i: number, m: RegExpExecArray): number {
  const closer = new RegExp(`^\\s*${m[2]![0] === "`" ? "`" : "~"}{${m[2]!.length},}\\s*$`);
  let j = i + 1;
  while (j < lines.length && !closer.test(lines[j]!)) j++;
  return j;
}

/** i 行目で開いた ::: の閉じの行番号。フェンスの中は数えない。 */
function directiveEnd(lines: string[], i: number): number {
  let depth = 1;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    const f = isFence(line);
    if (f) {
      j = fenceEnd(lines, j, f);
      continue;
    }
    const t = line.trim();
    if (t === ":::pagebreak") continue;
    if (DIRECTIVE_OPEN.test(t)) depth++;
    else if (DIRECTIVE_CLOSE.test(t) && --depth === 0) return j;
  }
  return lines.length;
}

/** "1-3,5" を行番号の集合へ。 */
function expandRanges(spec: string): Set<number> {
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

/**
 * ハイライト行を //addstart 〜 //addend で囲み、元の本文で削除表示だった行を //delstart 〜 //delend で囲む。
 * highlight の行番号は 1 始まりで、offset は code の先頭の行番号 - 1。
 */
function withMarkers(ctx: Ctx, code: string[], highlight: Set<number>, offset = 0): string[] {
  const del = ctx.deletions.get(codeKey(code)) ?? new Set<number>();
  const out: string[] = [];
  let add = false;
  let rm = false;
  code.forEach((line, k) => {
    const onAdd = highlight.has(k + 1 + offset);
    const onDel = del.has(k);
    if (add && !onAdd) out.push("//addend");
    if (rm && !onDel) out.push("//delend");
    if (onDel && !rm) out.push("//delstart");
    if (onAdd && !add) out.push("//addstart");
    add = onAdd;
    rm = onDel;
    out.push(line);
  });
  if (add) out.push("//addend");
  if (rm) out.push("//delend");
  return out;
}

interface Ctx {
  resources: Map<string, Record<string, unknown>>;
  images: PendingImage[];
  warnings: string[];
  /** 元の本文の画像の title（draw.io の "source=diagrams.net" など）。添付 ID ごと。 */
  imageTitles: Map<string, string>;
  /** 元の本文のコードの削除表示（//delstart〜//delend）。マーカーを除いたコードの本文ごとに、削除行の位置（0 始まり）。 */
  deletions: Map<string, Set<number>>;
}

const codeKey = (code: string[]): string => code.map((l) => l.replace(/^(\s*)\$ /, "$1").trimEnd()).join("\n");

/** 元の本文から、取り込みで落ちる画像の title とコードの削除表示を集める。 */
function readOriginal(original: string | undefined): Pick<Ctx, "imageTitles" | "deletions"> {
  const imageTitles = new Map<string, string>();
  const deletions = new Map<string, Set<number>>();
  if (original === undefined) return { imageTitles, deletions };
  for (const m of original.matchAll(/!\[[^\]]*\]\([^)\s]*\/api\/attachments\.redirect\?id=([^)\s&"]+)\s+("[^"]*")\)/g)) {
    imageTitles.set(m[1]!, m[2]!);
  }
  const lines = original.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const f = isFence(lines[i]!);
    if (!f) continue;
    const end = fenceEnd(lines, i, f);
    const ind = f[1]!.length;
    const code: string[] = [];
    const del = new Set<number>();
    let inDel = false;
    for (const raw of lines.slice(i + 1, end)) {
      const body = raw.slice(Math.min(ind, /^ */.exec(raw)![0].length));
      const t = body.trim();
      if (t === "//delstart") inDel = true;
      else if (t === "//delend") inDel = false;
      else if (t !== "//addstart" && t !== "//addend") {
        if (inDel) del.add(code.length);
        code.push(body);
      }
    }
    if (del.size > 0) deletions.set(codeKey(code), del);
    i = end;
  }
  return { imageTitles, deletions };
}

const warn = (ctx: Ctx, message: string): void => {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
};

function imageLine(ctx: Ctx, r: Record<string, unknown>): string {
  const id = String(r.id);
  const caption = typeof r.caption === "string" ? r.caption : typeof r.altText === "string" ? r.altText : "";
  const alt = caption.replace(/\s+/g, " ").replace(/\]/g, "\\]");
  if (typeof r.note === "string" && r.note.trim()) warn(ctx, `${id}: 注記は Outline に書けないため戻しませんでした`);
  const placement = (r.placement ?? {}) as { width?: unknown };
  const w = typeof placement.width === "number" && placement.width > 0 && placement.width < 1 ? Math.round(placement.width * 100) : undefined;
  const width = w !== undefined && w > 0 && w < 100 ? `{w=${w}}` : "";
  const outline = OUTLINE_IMAGE.exec(id);
  if (outline) {
    const t = ctx.imageTitles.get(outline[1]!);
    return `![${alt}](/api/attachments.redirect?id=${outline[1]}${t ? ` ${t}` : ""})${width}`;
  }
  const placeholder = `postext-resource:${id}`;
  if (!ctx.images.some((p) => p.resourceId === id)) ctx.images.push({ resourceId: id, placeholder });
  return `![${alt}](${placeholder})${width}`;
}

function tableLines(ctx: Ctx, r: Record<string, unknown>): string[] | null {
  const rows = ((r.table as { model?: { rows?: unknown } } | undefined)?.model?.rows ?? null) as
    | { content?: unknown; align?: unknown }[][]
    | null;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const width = Math.max(...rows.map((row) => row.length));
  const cell = (c: { content?: unknown } | undefined) =>
    String(c?.content ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, "<br>");
  const row = (cells: { content?: unknown }[]) => `| ${Array.from({ length: width }, (_, i) => cell(cells[i])).join(" | ")} |`;
  const sep = Array.from({ length: width }, (_, i) => {
    const a = rows[0]![i]?.align;
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  const out: string[] = [];
  if (typeof r.caption === "string" && r.caption.trim()) out.push(`\\: ${r.caption.trim()}`, "");
  out.push(row(rows[0]!), `| ${sep.join(" | ")} |`, ...rows.slice(1).map(row));
  if (rows.some((rr) => rr.some((c) => (c as { image?: unknown }).image))) warn(ctx, `${String(r.id)}: 表のセルの画像は Outline に戻せません`);
  return out;
}

function resourceLines(ctx: Ctx, line: string): string[] {
  const m = RESOURCE.exec(line.trim());
  const id = m ? attr(parseAttrs(m[1]!), "id") : undefined;
  const r = id !== undefined ? ctx.resources.get(id) : undefined;
  if (!r) {
    warn(ctx, `書籍にないリソースを参照しています: ${id ?? line.trim()}`);
    return [line.trim()];
  }
  if (r.kind === "bitmap" || r.kind === "svg") return [imageLine(ctx, r)];
  if (r.kind === "table") {
    const t = tableLines(ctx, r);
    if (t) return t;
  }
  warn(ctx, `Outline に戻せない種類のリソースです（${String(r.kind)}）: ${id}`);
  return [line.trim()];
}

/** コードフェンスの情報行（lang {attrs}）を分ける。 */
function splitInfo(info: string): { lang: string; attrs: [string, string][] } {
  const t = info.trim();
  const brace = t.indexOf("{");
  const lang = (brace < 0 ? t : t.slice(0, brace)).trim();
  const inner = brace < 0 ? "" : t.slice(brace + 1, t.lastIndexOf("}") > brace ? t.lastIndexOf("}") : undefined);
  return { lang, attrs: parseAttrs(inner) };
}

const attrsText = (attrs: [string, string][]): string =>
  attrs.map(([k, v]) => (/^[^\s"'{}]+$/.test(v) ? `${k}=${v}` : v.includes('"') ? `${k}='${v}'` : `${k}="${v}"`)).join(" ");

function codeBlock(ctx: Ctx, indent: string, marker: string, info: string, code: string[]): string[] {
  const { lang, attrs } = splitInfo(info);
  const title = attr(attrs, "title");
  const highlight = expandRanges(attr(attrs, "highlight") ?? "");
  const keep = attrs.filter(([k]) => k !== "title" && k !== "highlight");
  const head = keep.length > 0 ? `${lang} {${attrsText(keep)}}` : lang;
  const out: string[] = [];
  if (title !== undefined) out.push(`*${plain(title)}*`, "");
  out.push(`${marker}${head}`, ...withMarkers(ctx, code, highlight), marker);
  return out.map((l) => (indent && l ? indent + l : l));
}

/** 端末の囲みの中身（console フェンス）を bash と bash-output のフェンスへ戻す。 */
function terminalLines(ctx: Ctx, label: string | undefined, inner: string[]): string[] {
  const i = inner.findIndex((l) => isFence(l));
  const f = i >= 0 ? isFence(inner[i]!) : null;
  if (!f) {
    warn(ctx, "端末の囲みに console のコードがないため、中身をそのまま戻しました");
    return inner;
  }
  const end = fenceEnd(inner, i, f);
  const marker = f[2]!;
  const ind = f[1]!.length;
  const code = inner.slice(i + 1, end).map((l) => l.slice(Math.min(ind, /^ */.exec(l)![0].length)));
  const { attrs } = splitInfo(f[3]!);
  const highlight = expandRanges(attr(attrs, "highlight") ?? "");
  const keep = attrs.filter(([k]) => k !== "highlight" && k !== "title");
  let split = code.findIndex((l) => l.trim() !== "" && !/^\s*\$ /.test(l));
  if (split < 0) split = code.length;
  if (code.slice(split).some((l) => /^\s*\$ /.test(l))) warn(ctx, "端末の囲みで、実行結果の後ろにあるコマンドは実行結果として戻しました");
  let cmdEnd = split;
  while (cmdEnd > 0 && code[cmdEnd - 1]!.trim() === "") cmdEnd--;
  const commands = code.slice(0, cmdEnd).map((l) => l.replace(/^(\s*)\$ /, "$1"));
  const output = code.slice(split);
  const out: string[] = [];
  if (label !== undefined) out.push(`*${plain(label)}*`, "");
  const head = (lang: string) => (keep.length > 0 ? `${lang} {${attrsText(keep)}}` : lang);
  if (commands.length > 0) out.push(`${marker}${head("bash")}`, ...withMarkers(ctx, commands, highlight), marker);
  if (output.length > 0) {
    if (commands.length > 0) out.push("");
    out.push(`${marker}${commands.length > 0 ? "bash-output" : head("bash-output")}`, ...withMarkers(ctx, output, highlight, split), marker);
  }
  return out;
}

/** 手順の囲みの中身を、番号付きの項目へ戻す。 */
function stepLines(ctx: Ctx, title: string | undefined, inner: string[]): string[] {
  const out: string[] = [title ? `:::step ${title}` : ":::step"];
  for (let i = 0; i < inner.length; ) {
    const t = inner[i]!.trim();
    const cm = CALLOUT.exec(t);
    const attrs = cm ? parseAttrs(cm[1]!) : [];
    if (cm && attr(attrs, "type") === "step-item") {
      const end = directiveEnd(inner, i);
      const body = inner.slice(i + 1, end);
      let k = 0;
      while (k < body.length && body[k]!.trim() === "") k++;
      const bold = k < body.length ? BOLD_ONLY.exec(body[k]!.trim()) : null;
      const head = bold ? bold[1]! : "";
      if (!bold) warn(ctx, "手順の項目の先頭に太字の題がないため、題を空にしました");
      const label = attr(attrs, "label") ?? "1";
      const pad = " ".repeat(label.length + 2);
      const rest = render(ctx, bold ? body.slice(k + 1) : body);
      while (rest.length > 0 && rest[0] === "") rest.shift();
      push(out, [`${label}. ${head}`]);
      if (rest.length > 0) out.push("", ...rest.map((l) => (l ? pad + l : l)));
      out.push("");
      i = end + 1;
      continue;
    }
    if (t === "") {
      i++;
      continue;
    }
    // 項目の外にある本文は、そのまま囲みの中に置く。
    const end = nextStepItem(inner, i);
    push(out, render(ctx, inner.slice(i, end)));
    i = end;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  out.push(":::");
  return out;
}

function nextStepItem(lines: string[], from: number): number {
  for (let j = from; j < lines.length; j++) {
    const f = isFence(lines[j]!);
    if (f) {
      j = fenceEnd(lines, j, f);
      continue;
    }
    const cm = CALLOUT.exec(lines[j]!.trim());
    if (cm && attr(parseAttrs(cm[1]!), "type") === "step-item") return j;
    if (DIRECTIVE_OPEN.test(lines[j]!.trim()) && lines[j]!.trim() !== ":::pagebreak") j = directiveEnd(lines, j);
  }
  return lines.length;
}

/** 末尾が空行でなければ空行を足す。 */
function ensureBlank(out: string[]): void {
  if (out.length > 0 && out[out.length - 1] !== "") out.push("");
}

/** 前の段落と空行を1つ挟んで足す。中身（コードの空行など）はそのまま。 */
function push(out: string[], lines: string[]): void {
  let k = 0;
  while (k < lines.length && lines[k] === "") k++;
  if (k >= lines.length) return;
  ensureBlank(out);
  out.push(...lines.slice(k));
}

/** コードフェンスの外で、続く空行を1つにまとめる。 */
function collapseBlanks(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const f = isFence(lines[i]!);
    if (f) {
      const end = Math.min(fenceEnd(lines, i, f), lines.length - 1);
      out.push(...lines.slice(i, end + 1));
      i = end;
      continue;
    }
    if (lines[i] === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(lines[i]!);
  }
  return out;
}

function render(ctx: Ctx, lines: string[]): string[] {
  const out: string[] = [];
  const block = (ls: string[]) => {
    push(out, ls);
    out.push("");
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const f = isFence(line);
    if (f) {
      const end = fenceEnd(lines, i, f);
      const code = lines.slice(i + 1, end).map((l) => l.slice(Math.min(f[1]!.length, /^ */.exec(l)![0].length)));
      block(codeBlock(ctx, f[1]!, f[2]!, f[3]!, code));
      i = end + 1;
      continue;
    }
    const t = line.trim();
    if (t === ":::pagebreak") {
      block(["//clearpage"]);
      i++;
      continue;
    }
    if (RESOURCE.test(t)) {
      block(resourceLines(ctx, t));
      i++;
      continue;
    }
    const cm = CALLOUT.exec(t);
    if (cm) {
      const attrs = parseAttrs(cm[1]!);
      const type = attr(attrs, "type") ?? "";
      const label = attr(attrs, "label");
      const end = directiveEnd(lines, i);
      const inner = lines.slice(i + 1, end);
      i = end + 1;
      if (type === "chapter-contents") continue;
      if (type === "step") {
        // 囲みの直前の太字だけの段落は、手順の題。
        let last = out.length - 1;
        while (last >= 0 && out[last] === "") last--;
        const bold = last >= 0 && (last === 0 || out[last - 1] === "") ? BOLD_ONLY.exec(out[last]!) : null;
        if (bold) out.splice(last);
        block(stepLines(ctx, bold?.[1], inner));
        continue;
      }
      if (type === "terminal") {
        block(terminalLines(ctx, label, inner));
        continue;
      }
      const name = BACK_TO_OUTLINE[type];
      if (name) {
        const body = render(ctx, inner);
        while (body.length > 0 && body[0] === "") body.shift();
        while (body.length > 0 && body[body.length - 1] === "") body.pop();
        block([label !== undefined ? `:::${name} ${plain(label)}` : `:::${name}`, ...body, ":::"]);
        continue;
      }
      warn(ctx, `Outline にない囲み（${type || cm[1]}）は記法のまま戻しました`);
      block([t, ...render(ctx, inner), ":::"]);
      continue;
    }
    out.push(line);
    i++;
  }
  return out;
}

/** 元の本文の差し込み記法を、直前の行（なければ先頭）を目印に戻す。 */
function restoreTemplates(ctx: Ctx, out: string[], original: string): string[] {
  const lines = original.replace(/\r\n?/g, "\n").split("\n");
  const result = [...out];
  let prev: string | undefined;
  for (const l of lines) {
    if (TEMPLATE_ONLY.test(l)) {
      const at = prev === undefined ? 0 : result.findIndex((r) => r === prev) + 1;
      if (prev !== undefined && at === 0) {
        warn(ctx, `差し込み記法 ${l.trim()} の位置が見つからないため戻せませんでした`);
        continue;
      }
      result.splice(at, 0, ...(at > 0 ? [""] : []), l.trim(), "");
      prev = l;
      continue;
    }
    if (l.trim() !== "") prev = l;
  }
  return result;
}

/** 元の本文の先頭にある ```yaml の囲み。なければ空。 */
function leadingYaml(original: string): string[] {
  const lines = original.replace(/\r\n?/g, "\n").split("\n");
  let s = 0;
  while (s < lines.length && lines[s]!.trim() === "") s++;
  if (!/^```ya?ml\s*$/.test(lines[s] ?? "")) return [];
  let e = s + 1;
  while (e < lines.length && !/^```\s*$/.test(lines[e]!)) e++;
  return lines.slice(s, e + 1);
}

export function toOutlineMarkdown(chapterMarkdown: string, options: ReverseOptions): ReverseResult {
  const ctx: Ctx = {
    resources: new Map(options.resources.map((r) => [String(r.id), r])),
    images: [],
    warnings: [],
    ...readOriginal(options.original),
  };
  const lines = bodyOf(chapterMarkdown).replace(/\r\n?/g, "\n").split("\n");
  let s = 0;
  while (s < lines.length && lines[s]!.trim() === "") s++;
  const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(lines[s] ?? "");
  const title = h1 ? h1[1] : undefined;
  let out = render(ctx, h1 ? lines.slice(s + 1) : lines);
  while (out.length > 0 && out[0] === "") out.shift();
  if (options.original !== undefined) {
    const yaml = leadingYaml(options.original);
    const stripped = yaml.length > 0 ? options.original.replace(/\r\n?/g, "\n").split("\n").slice(yaml.length) : null;
    out = restoreTemplates(ctx, out, stripped ? stripped.join("\n") : options.original);
    if (yaml.length > 0) out = [...yaml, "", ...out];
  }
  const collapsed = collapseBlanks(out);
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") collapsed.pop();
  while (collapsed.length > 0 && collapsed[0] === "") collapsed.shift();
  return {
    ...(title !== undefined ? { title } : {}),
    markdown: collapsed.length > 0 ? `${collapsed.join("\n")}\n` : "",
    images: ctx.images,
    warnings: ctx.warnings,
  };
}
