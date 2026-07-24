CREATE TABLE IF NOT EXISTS "instance_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"slug" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"url" text NOT NULL,
	"auth_mode" varchar(20) DEFAULT 'static' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_instance_mcp_server_slug" UNIQUE("instance_id","slug")
);
--> statement-breakpoint
ALTER TABLE "instance_mcp_servers" ADD CONSTRAINT "instance_mcp_servers_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instance_mcp_servers_instance" ON "instance_mcp_servers" ("instance_id");
