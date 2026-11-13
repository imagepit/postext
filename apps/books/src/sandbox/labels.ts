import { createTranslator } from "next-intl";
import type { SandboxLabels } from "postext-sandbox";
import messages from "../../../web/messages/ja.json";
import { buildSandboxLabels } from "../../../web/src/components/sandbox/SandboxPage/labels";

type SandboxTranslator = Parameters<typeof buildSandboxLabels>[0];

export function japaneseSandboxLabels(): SandboxLabels {
  const translate = createTranslator({
    locale: "ja",
    messages: { Sandbox: messages.Sandbox },
    namespace: "Sandbox",
  });
  return buildSandboxLabels(translate as unknown as SandboxTranslator);
}
