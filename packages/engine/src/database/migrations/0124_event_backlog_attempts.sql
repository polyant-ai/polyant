-- How many cycles have claimed a Room event. A cycle that ends without completing
-- its events leaves them to be put back to pending, and each claim costs a model
-- call: after a bounded number of claims the event is completed as failed instead.
-- A constant default is a catalog change: no rewrite of the table.
ALTER TABLE "event_backlog" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
