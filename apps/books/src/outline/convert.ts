// Outline の Markdown を Postext の Markdown へ変換する。入出力を持たない純粋関数。
// 画像の取得とリソースの組み立ては resources.ts、章への書き込みは importBook.ts が行う。

export type TableAlign = "left" | "center" | "right";

export interface ConvertedImage {
  attachmentId: string;
  /** 本文の ::resource が参照するリソース ID。 */
  resourceId: string;
  alt: string;
  /** Outline の {w=NN}。NN が 100 未満のときだけ入る（100 以上は段の幅いっぱい）。 */
  widthPercent?: number;
}

export interface ConvertedTable {
  id: string;
  align: (TableAlign | undefined)[];
  header: string[];
  rows: string[][];
}

export interface ConvertResult {
  markdown: string;
  images: ConvertedImage[];
  tables: ConvertedTable[];
  warnings: string[];
}

export interface ConvertOptions {
  /** 表のリソース ID（outline-table-<先頭8文字>-<n>）に使う Outline の文書 ID。 */
  docId: string;
}

interface Ctx {
  docId: string;
  images: ConvertedImage[];
  variants: Map<string, number>;
  imageKeys: Map<string, string>;
  tables: ConvertedTable[];
  warnings: string[];
  warned: Set<string>;
}

const CALLOUT_TYPES = new Set(["note", "syntax", "step"]);
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*(.*)$/;
const ORDERED = /^(\d+)([.)])\s+(.*)$/;
const BULLET = /^([*+-])\s+(.*)$/;
const NESTED_LIST_LINE = /^\s+([*+-]|\d+[.)])\s+/;
const IMAGE_G = /!\[([^\]]*)\]\(([^)\s]*)\/api\/attachments\.redirect\?id=([^)\s&"]+)[^)]*\)(?:\{w=(\d+)\})?/g;
const IMAGE_ONE = new RegExp(IMAGE_G.source);
const OTHER_IMAGE = /!\[[^\]]*\]\([^)]*\)/;
const TEMPLATE_TAG = /\{\{[^}]*\}\}/g;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ITALIC_ONLY = /^\s*\*([^*\s](?:[^*]*[^*\s])?)\*\s*$/;

const warn = (ctx: Ctx, message: string, once = false): void => {
  if (once) {
    if (ctx.warned.has(message)) return;
    ctx.warned.add(message);
  }
  ctx.warnings.push(message);
};

/** Postext の属性値にはエスケープがない。二重引用符を含む値は一重引用符で囲み、両方を含む値は印刷用の引用符へ置き換える。 */
export function attrValue(raw: string): string {
  const v = raw.replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\s+/g, " ").trim();
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/"/g, "”")}"`;
}

function registerImage(ctx: Ctx, attachmentId: string, alt: string, width: string | undefined): string {
  const w = width ? Number(width) : undefined;
  const widthPercent = w !== undefined && w > 0 && w < 100 ? w : undefined;
  const key = `${attachmentId}|${widthPercent ?? ""}|${alt}`;
  const known = ctx.imageKeys.get(key);
  if (known) return known;
  const n = (ctx.variants.get(attachmentId) ?? 0) + 1;
  ctx.variants.set(attachmentId, n);
  const resourceId = n === 1 ? `outline-img-${attachmentId}` : `outline-img-${attachmentId}-${n}`;
  ctx.imageKeys.set(key, resourceId);
  ctx.images.push({
    attachmentId,
    resourceId,
    alt,
    ...(widthPercent !== undefined ? { widthPercent } : {}),
  });
  return resourceId;
}

type Segment = { text: string } | { resourceId: string };

/** 行を「文字」と「画像」に分ける。画像がなければ null。 */
function splitImages(ctx: Ctx, line: string): Segment[] | null {
  const segments: Segment[] = [];
  let last = 0;
  let found = false;
  for (const m of line.matchAll(IMAGE_G)) {
    found = true;
    if (m.index! > last) segments.push({ text: line.slice(last, m.index) });
    segments.push({ resourceId: registerImage(ctx, m[3]!, m[1] ?? "", m[4]) });
    last = m.index! + m[0].length;
  }
  if (!found) return null;
  if (last < line.length) segments.push({ text: line.slice(last) });
  return segments;
}

/** 差し込み記法を消す。 */
function cleanInline(ctx: Ctx, line: string): string {
  const cleaned = line.replace(TEMPLATE_TAG, (tag) => {
    warn(ctx, `Outlineの差し込み記法 ${tag} は取り込めないため削除しました`);
    return "";
  });
  if (OTHER_IMAGE.test(cleaned)) warn(ctx, `Outline外の画像は取り込めないため記法のまま残しました: ${cleaned.trim().slice(0, 60)}`);
  return cleaned;
}

function splitCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/<br\s*\/?>/gi, "\n"));
}

function parseTable(ctx: Ctx, rows: string[]): string {
  const header = splitCells(rows[0]!);
  const align = splitCells(rows[1]!).map((c): TableAlign | undefined => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : undefined;
  });
  const width = header.length;
  const fit = (cells: string[]): string[] => Array.from({ length: width }, (_, i) => cells[i] ?? "");
  const body = rows.slice(2).map((r) => fit(splitCells(r)));
  const id = `outline-table-${ctx.docId.slice(0, 8)}-${ctx.tables.length + 1}`;
  ctx.tables.push({ id, align: Array.from({ length: width }, (_, i) => align[i]), header, rows: body });
  if ([...header, ...body.flat()].some((c) => IMAGE_ONE.test(c))) {
    warn(ctx, "表のセル内の画像は取り込めないため記法のまま残しました");
  }
  return id;
}

function compressRanges(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    out.push(j > i ? `${lines[i]}-${lines[j]}` : `${lines[i]}`);
    i = j + 1;
  }
  return out.join(",");
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)![0].length;
}

function processLines(lines: string[], ctx: Ctx): string[] {
  const out: string[] = [];
  const blank = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };
  let pendingTitle: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // コードフェンス。中身は書いたまま保つ（マーカー行の除去だけ行う）。
    const fm = FENCE_OPEN.exec(line);
    if (fm && !(fm[2]![0] === "`" && fm[3]!.includes("`"))) {
      const indent = fm[1]!.length;
      const marker = fm[2]!;
      const info = fm[3]!.trim();
      let j = i + 1;
      const closer = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      while (j < lines.length && !closer.test(lines[j]!)) j++;
      if (j >= lines.length) warn(ctx, "閉じていないコードブロックがありました");
      const code: string[] = [];
      const highlight: number[] = [];
      let inAdd = false;
      let deleted = false;
      for (const raw of lines.slice(i + 1, j)) {
        const body = raw.slice(Math.min(indent, leadingSpaces(raw)));
        const t = body.trim();
        if (t === "//addstart") inAdd = true;
        else if (t === "//addend") inAdd = false;
        else if (t === "//delstart" || t === "//delend") deleted = true;
        else {
          code.push(body);
          if (inAdd) highlight.push(code.length);
        }
      }
      if (deleted) warn(ctx, "//delstart〜//delend の範囲は削除表示にできないため、行を残してマーカーだけ取り除きました");
      let lang = "";
      let rest = info;
      if (info && !info.startsWith("{")) {
        const sp = info.search(/\s/);
        lang = sp < 0 ? info : info.slice(0, sp);
        rest = sp < 0 ? "" : info.slice(sp).trim();
      }
      rest = rest.replace(/^\{(.*)\}$/, "$1").trim();
      const attrs: string[] = rest ? [rest] : [];
      if (pendingTitle !== undefined && !/\btitle\s*=/.test(rest)) attrs.push(`title=${attrValue(pendingTitle)}`);
      if (highlight.length > 0) attrs.push(`highlight="${compressRanges(highlight)}"`);
      pendingTitle = undefined;
      const head = attrs.length > 0 ? `${lang || "text"} {${attrs.join(" ")}}` : lang;
      blank();
      out.push(`${marker}${head}`, ...code, marker);
      blank();
      i = j + 1;
      continue;
    }

    // コードフェンスの直前の *題* は、そのフェンスの title にする。
    const italic = ITALIC_ONLY.exec(line);
    if (italic) {
      let k = i + 1;
      while (k < lines.length && lines[k]!.trim() === "") k++;
      if (k < lines.length && FENCE_OPEN.test(lines[k]!)) {
        pendingTitle = italic[1]!;
        i++;
        continue;
      }
    }

    const trimmed = line.trim();

    if (trimmed === "//clearpage") {
      blank();
      out.push(":::pagebreak");
      blank();
      i++;
      continue;
    }

    const dm = /^:::\s*([A-Za-z][\w-]*)?(?:\s+(.*))?$/.exec(trimmed);
    if (dm && dm[1]) {
      const name = dm[1];
      if (CALLOUT_TYPES.has(name)) {
        const title = (dm[2] ?? "").trim();
        blank();
        out.push(`:::callout{type="${name}"${title ? ` title=${attrValue(title)}` : ""}}`);
        i++;
        continue;
      }
      warn(ctx, `未対応のブロック :::${name} はテキストのまま残しました`);
      out.push(line);
      i++;
      continue;
    }
    if (trimmed === ":::") {
      blank();
      out.push(":::");
      blank();
      i++;
      continue;
    }

    // GFM の表。
    if (trimmed.startsWith("|") && i + 1 < lines.length && lines[i + 1]!.includes("|") && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim().startsWith("|")) j++;
      const id = parseTable(ctx, lines.slice(i, j));
      blank();
      out.push(`::resource{id="${id}"}`);
      blank();
      i = j;
      continue;
    }

    // リスト項目。続きの本文を持つ項目は、Postext が項目内にブロックを置けないため項目の外へ出す。
    const om = ORDERED.exec(line);
    const bm = om ? null : BULLET.exec(line);
    if (om || bm) {
      const markerWidth = om ? om[1]!.length + 2 : 2;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() === "") continue;
        if (/^( {2,}|\t)/.test(l)) end = j;
        else break;
      }
      const cont = lines.slice(i + 1, end + 1).map((l) => l.replace(/^\t/, "   "));
      const itemText = om ? om[3]! : bm![2]!;
      const marker = om ? `${om[1]}${om[2]} ` : `${bm![1]} `;
      const itemImages = splitImages(ctx, itemText);
      const head = itemImages ? itemImages.flatMap((s) => ("text" in s ? [s.text] : [])).join("").trim() : itemText;
      const headText = cleanInline(ctx, head);
      const simple =
        !itemImages &&
        cont.every((l) => l.trim() === "" || (NESTED_LIST_LINE.test(l) && !IMAGE_ONE.test(l) && !l.includes("|")));
      if (cont.length === 0 && !itemImages) {
        out.push(marker + headText);
        i++;
        continue;
      }
      if (simple) {
        out.push(marker + headText, ...cont.map((l) => cleanInline(ctx, l)));
        i = end + 1;
        continue;
      }
      const label = headText.trim() || "画像";
      const dedented = cont.map((l) => l.slice(Math.min(markerWidth, leadingSpaces(l))));
      const imageLines = (itemImages ?? []).flatMap((s) => ("resourceId" in s ? [`::resource{id="${s.resourceId}"}`] : []));
      if (om) warn(ctx, "番号付きリストの項目内の本文・画像・コードを項目の外へ移しました（番号はそのまま保持）", true);
      else warn(ctx, "箇条書きの項目内の本文・画像・コードを項目の外へ移しました", true);
      blank();
      out.push(marker + label);
      blank();
      for (const r of imageLines) {
        out.push(r);
        blank();
      }
      out.push(...processLines(dedented, ctx));
      blank();
      i = end + 1;
      continue;
    }

    // 画像だけの行、または画像を含む行。
    const segments = splitImages(ctx, line);
    if (segments) {
      const hasText = segments.some((s) => "text" in s && s.text.trim() !== "");
      if (hasText) warn(ctx, "文中の画像を単独の行へ分けました", true);
      for (const s of segments) {
        if ("resourceId" in s) {
          blank();
          out.push(`::resource{id="${s.resourceId}"}`);
          blank();
        } else if (s.text.trim() !== "") {
          const t = cleanInline(ctx, s.text.trim());
          if (t.trim()) {
            blank();
            out.push(t);
            blank();
          }
        }
      }
      i++;
      continue;
    }

    // 通常の行。
    if (trimmed === "") {
      blank();
      i++;
      continue;
    }
    const cleaned = cleanInline(ctx, line);
    if (cleaned.trim() === "") blank();
    else out.push(cleaned);
    i++;
  }
  return out;
}

function stripLeadingYaml(lines: string[]): string[] {
  let s = 0;
  while (s < lines.length && lines[s]!.trim() === "") s++;
  if (!/^```ya?ml\s*$/.test(lines[s] ?? "")) return lines;
  let e = s + 1;
  while (e < lines.length && !/^```\s*$/.test(lines[e]!)) e++;
  e++;
  while (e < lines.length && lines[e]!.trim() === "") e++;
  return lines.slice(e);
}

export function convertOutlineMarkdown(text: string, options: ConvertOptions): ConvertResult {
  const ctx: Ctx = {
    docId: options.docId,
    images: [],
    variants: new Map(),
    imageKeys: new Map(),
    tables: [],
    warnings: [],
    warned: new Set(),
  };
  const lines = stripLeadingYaml(text.replace(/\r\n?/g, "\n").split("\n"));
  const out = processLines(lines, ctx);
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return {
    markdown: out.length > 0 ? `${out.join("\n")}\n` : "",
    images: ctx.images,
    tables: ctx.tables,
    warnings: ctx.warnings,
  };
}
