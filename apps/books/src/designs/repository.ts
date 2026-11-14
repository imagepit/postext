import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { designs } from "../db/schema";
import type { DesignRepository } from "./model";

export function createPgDesignRepository(db: Db): DesignRepository {
  return {
    async list() {
      const rows = await db
        .select({
          id: designs.id,
          name: designs.name,
          description: designs.description,
          source: designs.source,
          parts: designs.parts,
          createdAt: designs.createdAt,
          updatedAt: designs.updatedAt,
          size: sql<number>`octet_length(${designs.bytes})`.mapWith(Number),
        })
        .from(designs)
        .orderBy(desc(designs.updatedAt), desc(designs.id));
      return rows.map(({ description, source, ...r }) => ({
        ...r,
        ...(description ? { description } : {}),
        ...(source ? { source } : {}),
      }));
    },

    async get(id) {
      const [row] = await db.select().from(designs).where(eq(designs.id, id));
      if (!row) return null;
      const { description, source, ...r } = row;
      return { ...r, ...(description ? { description } : {}), ...(source ? { source } : {}) };
    },

    async upsert(d) {
      const values = {
        name: d.name,
        description: d.description ?? null,
        source: d.source ?? null,
        parts: d.parts,
        bytes: d.bytes,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      };
      await db
        .insert(designs)
        .values({ id: d.id, ...values })
        .onConflictDoUpdate({ target: designs.id, set: values });
    },

    async delete(id) {
      const rows = await db.delete(designs).where(eq(designs.id, id)).returning({ id: designs.id });
      return rows.length > 0;
    },
  };
}
