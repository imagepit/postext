"use client";

import { useLayoutEffect, useState } from "react";
import {
  DEFAULT_MARKDOWN_JA,
  PostextSandbox,
  setSavedDesignStorage,
  type SandboxBookBridge,
  type SandboxLabels,
} from "postext-sandbox";
import { createServerDesignStore } from "@/designs/serverDesignStore";

export function BooksSandbox({
  labels,
  onBridgeReady,
}: {
  labels: SandboxLabels;
  onBridgeReady?: (bridge: SandboxBookBridge) => void;
}) {
  // 保存したデザインの置き場を、Sandbox が読む前にサーバーへ切り替える。
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    setSavedDesignStorage(createServerDesignStore());
    setReady(true);
    return () => setSavedDesignStorage(null);
  }, []);
  if (!ready) return null;
  return (
    <PostextSandbox
      initialMarkdown={DEFAULT_MARKDOWN_JA}
      labels={labels}
      locale="ja"
      onBridgeReady={onBridgeReady}
    />
  );
}
