-- The agents a person has starred, shown at the foot of the panel's sidebar. A new
-- table only: nothing existing is altered. Both foreign keys cascade, so deleting
-- the person or the agent removes the star with it.
CREATE TABLE IF NOT EXISTS "user_favorite_agents" (
	"user_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorite_agents_user_id_instance_id_pk" PRIMARY KEY("user_id","instance_id"),
	CONSTRAINT "user_favorite_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "user_favorite_agents_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_favorite_agents_instance_id" ON "user_favorite_agents" ("instance_id");
