import type { DesignPart } from "postext";
import {
  bigint,
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
  // 主言語。NULL は多言語対応前の書籍で、読むときは先頭の章の言語を主言語とみなす。
  locale: text("locale"),
  // 多言語の書籍で言語に共通の設定。
  sharedConfig: jsonb("shared_config").$type<Record<string, unknown>>(),
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

// 主言語以外の版。主言語の題名・設定・資源は books にある。
export const bookEditions = pgTable(
  "book_editions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookId: uuid("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    resources: jsonb("resources").$type<Record<string, unknown>[]>().notNull().default([]),
    start: jsonb("start").$type<Record<string, unknown>>(),
  },
  (t) => [unique("book_editions_book_locale").on(t.bookId, t.locale)],
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

// エディタの「デザインを保存」で保存したデザイン。書籍とは独立に残る。
export const designs = pgTable("designs", {
  // クライアントが作った id（design-xxxx）。
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // 保存元の書籍の名前。
  source: text("source"),
  parts: jsonb("parts").$type<DesignPart[]>().notNull(),
  // postext の createDesignBundle が作った .postext をそのまま保存する。
  bytes: bytea("bytes").notNull(),
  // SavedDesign.createdAt/updatedAt（ミリ秒）をそのまま往復させる。
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
