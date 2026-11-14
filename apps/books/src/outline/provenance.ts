// 章の frontmatter に Outline との対応（outline: id / updatedAt / hash）を書き、読む。
// ほかのキーは触らない。frontmatter の判定は Postext と同じ（1行目がちょうど --- で、次の --- 行で閉じる）。

import { createHash } from "node:crypto";

export interface OutlineProvenance {
  id: string;
  updatedAt: string;
  hash: string;
}

interface Split {
  /** frontmatter の中身（--- の行を除く）。なければ null。 */
  block: string[] | null;
  body: string;
}

function split(markdown: string): Split {
  const text = markdown.replace(/^﻿/, "");
  const lines = text.split("\n");
  if (lines[0]!.replace(/\r$/, "") !== "---") return { block: null, body: text };
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.replace(/\r$/, "");
    if (l === "---" || l === "...") {
      return { block: lines.slice(1, i), body: lines.slice(i + 1).join("\n") };
    }
  }
  return { block: null, body: text };
}

/** frontmatter を除いた本文。 */
export const bodyOf = (markdown: string): string => split(markdown).body;

/** 改行と行末の空白の違いでは変わらない本文のハッシュ。 */
export function hashBody(body: string): string {
  const normal = body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return createHash("sha256").update(normal, "utf8").digest("hex");
}

const unquote = (raw: string): string => {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
};

function outlineRange(block: string[]): [number, number] | null {
  const start = block.findIndex((l) => /^outline\s*:/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < block.length && /^[ \t]+\S/.test(block[end]!)) end++;
  return [start, end];
}

export function readProvenance(markdown: string): OutlineProvenance | null {
  const { block } = split(markdown);
  if (!block) return null;
  const range = outlineRange(block);
  if (!range) return null;
  const found: Partial<OutlineProvenance> = {};
  for (const l of block.slice(range[0] + 1, range[1])) {
    const m = /^[ \t]+(id|updatedAt|hash)\s*:\s*(.*)$/.exec(l.replace(/\r$/, ""));
    if (m) found[m[1] as keyof OutlineProvenance] = unquote(m[2]!);
  }
  return found.id && found.updatedAt && found.hash ? (found as OutlineProvenance) : null;
}

/**
 * markdown の frontmatter（なければ新規）に outline を書き、本文を body に置き換える。
 * outline 以外のキーはそのまま残す。
 */
export function writeChapter(existing: string, body: string, provenance: OutlineProvenance): string {
  const { block } = split(existing);
  const kept = block ? [...block] : [];
  const range = outlineRange(kept);
  if (range) kept.splice(range[0], range[1] - range[0]);
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  const entry = [
    "outline:",
    `  id: ${JSON.stringify(provenance.id)}`,
    `  updatedAt: ${JSON.stringify(provenance.updatedAt)}`,
    `  hash: ${JSON.stringify(provenance.hash)}`,
  ];
  return `---\n${[...kept, ...entry].join("\n")}\n---\n${body}`;
}
