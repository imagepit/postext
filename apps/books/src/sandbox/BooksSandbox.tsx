"use client";

import { DEFAULT_MARKDOWN_JA, PostextSandbox, type SandboxBookBridge, type SandboxLabels } from "postext-sandbox";

export function BooksSandbox({
  labels,
  onBridgeReady,
}: {
  labels: SandboxLabels;
  onBridgeReady?: (bridge: SandboxBookBridge) => void;
}) {
  return (
    <PostextSandbox
      initialMarkdown={DEFAULT_MARKDOWN_JA}
      labels={labels}
      locale="ja"
      onBridgeReady={onBridgeReady}
    />
  );
}
