"use client";

import { DEFAULT_MARKDOWN_JA, PostextSandbox, type SandboxLabels } from "postext-sandbox";

export function BooksSandbox({ labels }: { labels: SandboxLabels }) {
  return <PostextSandbox initialMarkdown={DEFAULT_MARKDOWN_JA} labels={labels} locale="ja" />;
}
