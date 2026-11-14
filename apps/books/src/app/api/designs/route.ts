import { getDb } from "@/db/client";
import { createPgDesignRepository } from "@/designs/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const designs = await createPgDesignRepository(getDb()).list();
  return Response.json({ designs });
}
