# Knowledge & official docs

The agents are grounded against TeamViewer's **official documentation** so they answer accurately
instead of hallucinating, and stay honest when they don't know.

## Two layers ([src/knowledge/teamviewerDocs.ts](../src/knowledge/teamviewerDocs.ts))

1. **Verified facts** — a curated, offline set of facts confirmed against the official KB and the
   Web API v1 spec (primary port `5938` → fallback `443` → `80`; Web API base
   `https://webapi.teamviewer.com/api/v1` and its documented endpoints; the fact that TeamViewer
   publishes no fixed server IP/hostname list; DEX = 1E Client; per-product delivery models).
   These ground every specialist prompt and are always available with no network.

2. **Local documentation index (hybrid RAG, local ONNX embeddings)** — `twc docs reindex` crawls
   the **entire** official TeamViewer Knowledge Base in one pass and builds a local index;
   answers then run **fully offline against that index** — there is **no web search at query
   time**. Because `teamviewer.com` rejects direct fetches behind its WAF, the index is populated
   through **[Jina Reader](https://jina.ai/reader/)** (`https://r.jina.ai/...`), which fetches
   pages server-side and returns clean Markdown. Jina is **free and needs no API key** (set
   `JINA_API_KEY` only to raise rate limits). The Markdown is split into chunks and stored in an
   embedded **[LanceDB](https://lancedb.com/)** table under `~/.twc/knowledge/lancedb/` (with a
   small `lance-meta.json` sidecar).

   Retrieval is **always hybrid** — there is **no keyword-only fallback**:
   - **Keyword** overlap scoring — deterministic, the backbone of confidence.
   - **Semantic** cosine similarity — embeddings computed **in-process by a local ONNX model**
     via [Transformers.js](https://github.com/huggingface/transformers.js)
     ([src/knowledge/localEmbedder.ts](../src/knowledge/localEmbedder.ts)).

   Embeddings are **mandatory** and run **100% on-device, free and offline once cached**. The
   default model `Xenova/all-MiniLM-L6-v2` (~90 MB, 384-dim) is downloaded once from the Hugging
   Face hub on first `docs reindex`, then reused offline; override it with `TWC_EMBED_MODEL`.
   Foundry Local cannot serve embeddings (its catalog ships only chat-completion models), so the
   embedder is independent — it remains the hard gate only for the **chat agents**.

3. **Staying current** — the index is a snapshot; re-run `twc docs reindex` to rebuild the whole
   KB, or `twc docs refresh` for an incremental top-up of only the pages not already indexed
   (both fetched via Jina).

4. **Just-in-time KB retrieval (live fallback)** — the curated index covers a small, high-value
   core; the wider TeamViewer Knowledge Base is far larger. When the core **cannot answer a
   question confidently**, a just-in-time pass kicks in: it consults a **lightweight URL map** of
   the KB (titles + URLs only, a few KB on disk at `~/.twc/knowledge/url-map.json`, harvested
   from the KB landing page and refreshed weekly), ranks the best-matching pages, **fetches the
   top few live via Jina**, embeds them **on the fly**, and answers from that fresh context. The
   newly embedded chunks are **folded back into the local index**, so the second time a topic is
   asked it is already cached. Build/inspect the map with `twc docs map`; set `TWC_NO_JIT=1` to
   disable the live pass (core-only).

Every specialist agent and the gateway agent get a `tw-official-docs` tool. When a model is
unsure it calls the tool; if the answer isn't grounded the tool returns `confident: false` and
the agent points the user to the cited official URL rather than guessing.

## `docs ask` — LLM-grounded by default

`docs ask` requires **Foundry Local** (no fallback) — see
[src/knowledge/llmCompose.ts](../src/knowledge/llmCompose.ts). The hybrid LanceDB retriever
selects the most relevant chunks, a local Foundry Local model rephrases **only** that retrieved
context, and every generated sentence is then **verified by embedding similarity** against the
same context — unsupported sentences are dropped.

To stay solid with small local models the composer:

- hands the model the **whole retrieved chunk** (not a truncated half);
- **sanitises** the raw output before grounding — de-glues run-together tokens
  (`5938TCP` → `5938 TCP`), strips stray `NOT_IN_CONTEXT` markers, removes markdown code fences
  and links, and collapses looped repeats so a correct answer is never thrown away over a
  formatting artifact;
- **strips the recurring marketing/navigation footer** (the site-wide
  "TeamViewer ONE — Key integrations: Microsoft Intune, ServiceNow, …" promo block that ~66% of
  KB pages carry, plus footer-only chunks are dropped) so a small model can't paraphrase
  boilerplate and unrelated footer-bearing pages can't leak into `Sources:`;
- weights **title + URL-slug coverage** in retrieval ranking (a page slugged
  `.../install-teamviewer-classic-on-windows` wins decisively over a page that merely happens to
  contain the word "installation" deep in its body), so the most on-topic article is reliably
  rank #1;
- picks the **single best-matching context chunk per sentence** (argmax cosine) rather than
  every chunk above a threshold, so a short generic answer no longer cites the whole retrieved
  set.

If nothing is grounded the command declines honestly (`Confident: no`) instead of guessing, and
the cited `Sources:` come **only from the chunks that actually grounded a verified sentence**.

The agents' `tw-official-docs` tool stays extractive
([src/mastra/tools/knowledgeTool.ts](../src/mastra/tools/knowledgeTool.ts)) to avoid
agent→tool→agent recursion.

## Tuning & debug

| Env var | Default | Purpose |
|---|---|---|
| `TWC_CONTEXT_HITS` | `3` | How many retrieved chunks are handed to the model |
| `TWC_CONTEXT_CHARS` | `1200` | Per-chunk character budget in the prompt |
| `TWC_GROUND_MIN` | `0.40` | Per-sentence grounding cosine threshold |
| `TWC_DOCS_DEBUG` | unset | Set to `1` to print retrieval hits, prompt size, LLM wall-clock time and raw model output to stderr |
| `TWC_NO_JIT` | unset | Set to `1` to disable just-in-time live KB retrieval |
| `TWC_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Override the local ONNX embedder model |
| `JINA_API_KEY` | unset | Optional — raises Jina Reader rate limits |

## Commands

```powershell
twc docs reindex                  # crawl the whole KB + build the local index (via Jina)
twc docs refresh                  # incremental top-up of new KB pages only
twc docs index                    # show index status (chunks / embeddings)
twc docs map                      # show the KB URL map (just-in-time lookups)
twc docs ask "<question>"         # LLM answer grounded on the local index
twc docs sources                  # list the official doc URLs
twc docs sync                     # pre-fetch & cache raw doc text (offline)
```
