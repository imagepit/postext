CREATE TABLE "book_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start" jsonb,
	CONSTRAINT "book_editions_book_locale" UNIQUE("book_id","locale")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "shared_config" jsonb;--> statement-breakpoint
ALTER TABLE "book_editions" ADD CONSTRAINT "book_editions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;