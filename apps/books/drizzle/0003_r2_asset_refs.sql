CREATE TABLE "book_version_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"sha256" text NOT NULL,
	"storage" text NOT NULL,
	"object_key" text NOT NULL,
	"size" integer NOT NULL,
	CONSTRAINT "book_version_assets_version_path" UNIQUE("version_id","path")
);
--> statement-breakpoint
CREATE TABLE "design_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"sha256" text NOT NULL,
	"storage" text NOT NULL,
	"object_key" text NOT NULL,
	"size" integer NOT NULL,
	CONSTRAINT "design_assets_design_path" UNIQUE("design_id","path")
);
--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "storage" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "object_key" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "book_version_assets" ADD CONSTRAINT "book_version_assets_version_id_book_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."book_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_assets" ADD CONSTRAINT "design_assets_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 既存の行は bytes を持つので、size だけここで埋める。bytes の R2 への移動は scripts/migrate-assets-to-r2.ts が行う。
UPDATE "assets" SET "size" = octet_length("bytes") WHERE "bytes" IS NOT NULL;
