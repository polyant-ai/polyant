-- A text search configuration for the QUERY side of knowledge full-text search.
-- It reads a question like 'simple' does (lowercase, no stemming) but drops
-- Italian and English stopwords, so a question asked in natural language keeps
-- only the words that can match. Chunks keep their 'simple' index: every word
-- this configuration keeps is lowercased exactly as 'simple' indexed it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_dict WHERE dictname = 'knowledge_stop_italian') THEN
    CREATE TEXT SEARCH DICTIONARY knowledge_stop_italian (TEMPLATE = pg_catalog.simple, STOPWORDS = italian, ACCEPT = false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_dict WHERE dictname = 'knowledge_stop_english') THEN
    CREATE TEXT SEARCH DICTIONARY knowledge_stop_english (TEMPLATE = pg_catalog.simple, STOPWORDS = english, ACCEPT = false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'knowledge_query') THEN
    CREATE TEXT SEARCH CONFIGURATION knowledge_query (COPY = pg_catalog.simple);
    -- ACCEPT = false passes a word that is not a stopword on to the next
    -- dictionary; 'simple' then keeps it.
    ALTER TEXT SEARCH CONFIGURATION knowledge_query
      ALTER MAPPING FOR asciiword, word, numword, asciihword, hword, numhword, hword_asciipart, hword_part, hword_numpart
      WITH knowledge_stop_italian, knowledge_stop_english, simple;
  END IF;
END $$;
