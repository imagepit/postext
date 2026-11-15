ALTER TABLE "assets" ALTER COLUMN "storage" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "object_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" DROP COLUMN "bytes";