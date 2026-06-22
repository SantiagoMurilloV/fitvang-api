ALTER TABLE "notifications" ADD COLUMN "push_sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key");