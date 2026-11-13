import { BooksSandbox } from "@/sandbox/BooksSandbox";
import { japaneseSandboxLabels } from "@/sandbox/labels";

export default function Home() {
  return (
    <div className="h-dvh w-screen overflow-hidden">
      <BooksSandbox labels={japaneseSandboxLabels()} />
    </div>
  );
}
