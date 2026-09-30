-- The 5-minute-TTL share of a turn's cache writes.
--
-- Anthropic prices a 5m cache write at 1.25x input and a 1h write at 2x, and
-- reports the split per call (`usage.cache_creation`). A turn mixes both: the
-- cross-turn breakpoints default to 1h, the within-turn step marker is always
-- 5m. With only the total on the trace, a reader recosting the turn (the eval
-- harness, under each model it compares) had to price every write at 1h.
-- NULL when the provider reported no split, and on every older row: those
-- writes stay priced at the model's single `cacheWrite` rate, as before.
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "cache_creation_5m_input_tokens" integer;
