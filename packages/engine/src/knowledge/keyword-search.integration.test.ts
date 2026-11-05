// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The full-text half of knowledge search answers a question asked in natural
 * language. It runs on its own here, so the vector half cannot mask a keyword
 * search that finds nothing.
 *
 * Self-skips when no migrated database is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseAvailability } from "../database/test-db.js";
import { queryClient } from "../database/client.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { searchByKeyword } from "./store.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const AGENT = asInstanceSlug(`itest-kwsearch-${Date.now()}`);
const VECTOR = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

const HOURS_IT = "Orari di apertura: il negozio è aperto dal lunedì al venerdì, dalle 9 alle 18.";
const HOURS_EN = "Opening hours: Monday to Friday, 9 am to 6 pm. Closed on public holidays.";
const PRICES = "Il listino prezzi aggiornato è disponibile su richiesta all'ufficio commerciale.";
// Shares with the Italian question only words that carry no meaning.
const ONLY_STOPWORDS = "Gli articoli che sono stati spediti ieri sono in viaggio.";

describe.skipIf(!DB_AVAILABLE)("searchByKeyword with a natural-language question (integration)", () => {
  beforeAll(async () => {
    const [doc] = await queryClient<{ id: string }[]>`
      INSERT INTO knowledge_documents (instance_id, filename, mime_type, raw_content, status)
      VALUES (${AGENT}, 'faq.md', 'text/markdown', 'x', 'ready') RETURNING id`;
    const rows = [HOURS_IT, HOURS_EN, PRICES, ONLY_STOPWORDS].map((content, i) => ({
      document_id: doc!.id,
      instance_id: AGENT,
      content,
      embedding_1024: VECTOR,
      chunk_index: i,
    }));
    await queryClient`INSERT INTO knowledge_chunks ${queryClient(rows)}`;
  });

  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await queryClient`DELETE FROM knowledge_documents WHERE instance_id = ${AGENT}`;
  });

  const contents = async (query: string) => (await searchByKeyword(query, AGENT, 10)).map((r) => r.content);

  it("finds the chunk that answers an Italian question", async () => {
    const found = await contents("Quali sono gli orari di apertura?");

    expect(found[0]).toBe(HOURS_IT);
    expect(found).not.toContain(ONLY_STOPWORDS);
  });

  it("finds the chunk that answers an English question", async () => {
    expect((await contents("What are the opening hours?"))[0]).toBe(HOURS_EN);
  });

  it("still finds the chunk when the question has words the chunk lacks", async () => {
    expect((await contents("quali sono gli orari di apertura della sede in centro"))[0]).toBe(HOURS_IT);
  });

  it("takes quotes, backslashes and operators in the question as plain text", async () => {
    expect((await contents(`orari d'apertura? C:\\dir\\file.txt "lunedì" -venerdì | !`))[0]).toBe(HOURS_IT);
  });

  it("returns nothing, without failing, for a question made only of stopwords", async () => {
    expect(await contents("sono gli")).toEqual([]);
    expect(await contents("what is it")).toEqual([]);
  });
});
