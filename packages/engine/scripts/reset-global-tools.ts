import { db } from "../src/database/client.js";
import { queryClient } from "../src/database/client.js";
import { tools } from "../src/agents/tools/tools.schema.js";
import { eq } from "drizzle-orm";

async function main() {
  await db
    .update(tools)
    .set({ isGlobal: false })
    .where(eq(tools.isGlobal, true));
  console.log("All tools set to is_global=false");
  await queryClient.end();
}

main().catch(console.error);
