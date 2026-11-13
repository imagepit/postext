import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const books = pgTable("books", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  // .postext の preset.json の config に当たる。
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  // 画像などの資源の定義。本体のバイト列は assets にある。
  resources: jsonb("resources").$type<Record<string, unknown>[]>().notNull().default([]),
  // 保存のたびに1増える。呼び出し側が読んだ値と照合して競合を見つける。
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chapters = pgTable(
  "chapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    markdown: text("markdown").notNull(),
  },
  (t) => [unique("chapters_book_position").on(t.bookId, t.position)],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"resource" | "font">().notNull(),
    path: text("path").notNull(),
    mime: text("mime").notNull(),
    bytes: bytea("bytes").notNull(),
    sha256: text("sha256").notNull(),
  },
  (t) => [unique("assets_book_path").on(t.bookId, t.path)],
);

export const bookVersions = pgTable(
  "book_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    label: text("label").notNull().default(""),
    revision: integer("revision").notNull(),
    bundle: bytea("bundle").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("book_versions_book_number").on(t.bookId, t.number),
    index("book_versions_book_idx").on(t.bookId),
  ],
);
