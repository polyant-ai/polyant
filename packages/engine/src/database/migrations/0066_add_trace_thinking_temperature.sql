-- Extended-thinking flag + sampling temperature per turn on pipeline_traces.
-- Surfaced in the conversation debug view alongside model/cost/latency. Both
-- nullable: legacy rows and turns that used the provider-default temperature
-- simply have no value.
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "thinking" boolean;
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "temperature" real;
