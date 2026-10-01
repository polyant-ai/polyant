# Load and performance tests

These scripts measure what the platform itself costs under load, separately
from the model provider. They start a throwaway environment on one machine,
sized like a production task, fill it with a synthetic high-volume dataset,
and drive it with [k6](https://k6.io) and a real browser. A fake model and a
fake MCP server answer with fixed, configurable latency, so every millisecond
above that latency is the platform's.

Nothing here touches a shared database or a deployed environment.

## What it measures

| Question | Script | Main figures |
|---|---|---|
| How fast is each panel endpoint on a large tenant, one user at a time? | `k6/endpoints.js` | latency per endpoint and persona |
| How many conversations can run in parallel? | `k6/chat.js` | turn time, platform overhead (turn time minus the fake model's time), failures |
| How many panel users can work at once, and do large tenants slow small ones? | `k6/panel.js` | page load time per page, split by organization size |
| How many live connections does the engine hold? | `open-sse-connections.mjs` | accepted and refused activity streams |
| How do pages load in a browser, on desktop and on a phone? | `browser/measure-pages.mjs`, `browser/measure-mobile.mjs` | paint timings, time to settled page, API calls, JavaScript shipped, horizontal overflow |
| Where does the engine spend CPU? | `summarize-cpu-profile.mjs` | self time by package and by function |
| How does a vector search scale with an agent's knowledge base? | `sql/probe-vector-search.sql` | query plans and timings per agent size |

Every load test also records, every two seconds, the CPU and memory of the
engine and of Postgres, Postgres sessions (active, idle in a transaction,
waiting on a lock) and `/health` latency, which rises when the event loop is
blocked. After the run it stores the costliest and the most frequent SQL
statements from `pg_stat_statements`.

## The environment

| Part | Default | Why |
|---|---|---|
| Engine | Docker, 0.75 vCPU, 1536 MiB, port 4400 | the engine's share of a production task (`infra/config/_example.yaml`) |
| Web | Docker, 0.25 vCPU, 512 MiB, behind nginx on port 4480 | nginx routes like the load balancer (`nginx.conf`) |
| Postgres | `pgvector/pgvector:pg16`, 2 vCPU, 2 GiB, port 55432 | `pg_stat_statements` on, 200 connections |
| Fake model | `fake-llm.mjs`, port 7070 | OpenAI Responses API (streaming and not) and embeddings; 800 ms to first token, 60 tokens 20 ms apart: about 2 s per answer |
| Fake MCP server | `fake-mcp.mjs`, port 7171 | 8 tools; 50 ms initialize, 30 ms list, 150 ms call |

The engine reaches the fake model through `OPENAI_BASE_URL`, which the OpenAI
provider honours. Ports, container names, images and sizes can all be
overridden from the environment (see `env.sh`), so a second environment can
run next to the first.

The dataset (`sql/`) holds one large organization with about half of the
traffic, many small organizations, and one channel conversation with twenty
thousand messages. At `SCALE=full`: 200 organizations, about 1,800 agents,
200,000 conversations, 2 million messages, a million model-call and trace
rows, 1,000 users and 180,000 knowledge-base chunks: about 4.4 GB, built in
about five minutes.
Sessions are minted offline from the engine's own secret (`mint-sessions.mjs`),
so no login flow is involved.

## Running it

Requirements: Docker, Node 22 or later, and `npm ci` at the repository root.
k6 runs from its Docker image.

```bash
cd scripts/perf
./prepare-environment.sh                 # builds images, seeds, starts everything (SCALE=small to check the scripts in seconds)
./run-load-test.sh endpoints endpoints.js -e ITER=5
./run-load-test.sh chat-ramp chat.js -e STAGES=10,25,50,100,200 -e STAGE_S=60
node summarize-stages.mjs chat-ramp 10,25,50,100,200 60 turn_ms platform_overhead_ms turn_failed
./run-load-test.sh panel-ramp panel.js -e STAGES=10,25,50,100 -e STAGE_S=60
node summarize-stages.mjs panel-ramp 10,25,50,100 60 --by org page_dashboard_ms page_conversations_ms req_failed
node open-sse-connections.mjs 100 30
./start-web.sh && node browser/measure-pages.mjs 3 && node browser/measure-mobile.mjs
./reset-database.sh                      # back to the seeded state between runs that write
./stop-environment.sh
```

Results land in `.work/results/<label>/`, which git ignores along with the
rest of `.work/`.

### Variants

- **Tool calls.** Restart the fake model with `FAKE_TOOLS`, an ordered list of
  substrings of tool names. It calls each in turn, one per step, then answers.
  Pass the extra decision time to `chat.js` so the overhead stays the
  platform's:
  ```bash
  FAKE_TOOLS=searchKnowledge FAKE_TOOL_ARGS='{"searchKnowledge":{"query":"orari apertura","limit":5}}' ./start-fake-providers.sh
  ./run-load-test.sh kb chat.js -e AGENTS=agents-kb.tsv -e MODEL_MS=2450 -e STAGES=10,25,50 -e STAGE_S=60
  ```
- **MCP.** The engine refuses private MCP hosts when `NODE_ENV=production`, so
  run the engine with `./start-engine.sh -e NODE_ENV=development`, and the
  control run without MCP in the same mode. Register the fake server with
  `node register-mcp-server.mjs agents-100.tsv` (`--disable` to undo); with
  `FAKE_TOOLS=lookup_order` the model calls it on every turn.
- **Agent spread.** `chat.js` picks from `.work/agents.tsv` (100 agents by
  default); `-e AGENTS=agents-1000.tsv` spreads the same load over 1,000.
- **Another build.** `ENGINE_IMAGE=<image> ./start-engine.sh` compares a branch,
  a Node version or a flag; extra arguments go to `docker run`, e.g.
  `-e NODE_OPTIONS=--max-semi-space-size=64`.
- **CPU profile.** Start the engine with
  `-e NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/prof" -v "$PWD/.work/prof:/prof"`,
  run the load, stop the container (the profile is written on exit), then
  `node summarize-cpu-profile.mjs .work/prof/<file>.cpuprofile`. Delete the
  profile the migrations step writes first.
- **Rate limit on.** The engine starts with the rate limit off, or a load test
  would mostly measure 429s; `THROTTLE_ENABLED=true ./start-engine.sh` turns it
  on to see what real traffic hits.
- **More live connections.** The engine caps activity streams per process and
  per user (platform settings `sse_max_connections`,
  `sse_max_connections_per_user`). Raise them in `platform_settings` to measure
  what connections actually cost; the cap is cached for ten seconds.

## Reading the numbers

- `platform_overhead_ms` is a turn's duration minus `MODEL_MS`, the time the
  fake model takes. It includes everything the platform does before, around
  and after the model call that the client waits for.
- `docker stats` reports CPU as a percentage of one core: with 0.75 vCPU the
  engine tops out at 75%.
- Ramps hold each stage after a 10 s ramp; `summarize-stages.mjs` reports only
  the hold windows. Requests k6 cuts at the end of a run show as status 0.
- An endpoint that answers 404 is absent from this edition: `endpoints.js`
  reports it once and leaves it out. A browser page with no API calls is the
  same case.
- A browser page is settled when nothing but the activity stream has been in
  flight for one second, scripts included: a page still downloading a large
  chunk is not settled even if its API calls are done.

## Limits

- The knowledge-base vectors are random. Latency and result counts are
  meaningful; recall is not, and an HNSW index navigates random vectors worse
  than real embeddings, so validate any vector-index conclusion on real data.
- Postgres runs locally with fixed resources; a managed database adds network
  latency and scales differently.
- The fake model answers every call the same way. Real latency varies, and
  long, bursty streams load the engine differently.
- One engine process: anything held in process memory is measured as if it
  were global.
