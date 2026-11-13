import { BookEditor } from "@/editor/BookEditor";
import { japaneseSandboxLabels } from "@/sandbox/labels";

export default async function BookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  return <BookEditor bookId={bookId} labels={japaneseSandboxLabels()} />;
}
