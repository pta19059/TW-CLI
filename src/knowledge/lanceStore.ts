// ────────────────────────────────────────────────────────────────────────────
// LanceDB storage layer for the local hybrid RAG index
//
// Replaces the single rag-index.json blob with an embedded LanceDB table
// (columnar, on-disk, no server — runs in-process, ARM64-friendly). The
// retrieval math (keyword scoring + cosine + RRF fusion) is unchanged: this
// module only owns persistence. Chunks are loaded back into memory for scoring,
// which is instant for the curated corpus and gives us incremental `add()` for
// just-in-time enrichment (no full-file rewrite) plus a clear path to native
// ANN/FTS pushdown later.
//
// A tiny sidecar meta file keeps builtAt + embeddingModel (LanceDB tables don't
// carry arbitrary metadata). On first use we transparently import a legacy
// rag-index.json if present, so existing installs don't need a reindex.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { KNOWLEDGE_DIR } from "../paths.js";
import type { IndexChunk } from "./teamviewerDocs.js";

const LANCE_DIR = path.join(KNOWLEDGE_DIR, "lancedb");
const META_FILE = path.join(KNOWLEDGE_DIR, "lance-meta.json");
const LEGACY_INDEX_FILE = path.join(KNOWLEDGE_DIR, "rag-index.json");
const TABLE = "chunks";

interface LanceMeta {
  builtAt: string;
  embeddingModel?: string;
}

interface LanceRow {
  id: string;
  docId: string;
  url: string;
  title: string;
  text: string;
  vector: number[];
}

function readMeta(): LanceMeta | null {
  try {
    if (!existsSync(META_FILE)) return null;
    return JSON.parse(readFileSync(META_FILE, "utf8")) as LanceMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: LanceMeta): void {
  try {
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    writeFileSync(META_FILE, JSON.stringify(meta), "utf8");
  } catch {
    /* meta is best-effort */
  }
}

/** Only chunks that carry an embedding can live in the vector table. */
function toRow(c: IndexChunk): LanceRow | null {
  if (!c.embedding || c.embedding.length === 0) return null;
  return { id: c.id, docId: c.docId, url: c.url, title: c.title, text: c.text, vector: c.embedding };
}

function fromRow(r: Record<string, unknown>): IndexChunk {
  const v = r.vector as ArrayLike<number> | undefined;
  return {
    id: String(r.id),
    docId: String(r.docId),
    url: String(r.url),
    title: String(r.title),
    text: String(r.text),
    embedding: v ? Array.from(v) : undefined
  };
}

async function connect(): Promise<lancedb.Connection> {
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  return lancedb.connect(LANCE_DIR);
}

/**
 * One-time import of a legacy rag-index.json into LanceDB. Returns true if the
 * table now exists (either it already did, or we just imported the legacy file).
 */
async function ensureMigrated(db: lancedb.Connection): Promise<boolean> {
  const names = await db.tableNames();
  if (names.includes(TABLE)) return true;
  if (!existsSync(LEGACY_INDEX_FILE)) return false;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_INDEX_FILE, "utf8")) as {
      builtAt?: string;
      embeddingModel?: string;
      chunks?: IndexChunk[];
    };
    const rows = (legacy.chunks ?? []).map(toRow).filter((r): r is LanceRow => r !== null);
    if (rows.length === 0) return false;
    await db.createTable(TABLE, rows as unknown as Record<string, unknown>[], { mode: "overwrite" });
    writeMeta({ builtAt: legacy.builtAt ?? new Date().toISOString(), embeddingModel: legacy.embeddingModel });
    return true;
  } catch {
    return false;
  }
}

async function openTable(): Promise<lancedb.Table | null> {
  try {
    const db = await connect();
    if (!(await ensureMigrated(db))) return null;
    return await db.openTable(TABLE);
  } catch {
    return null;
  }
}

/** Load every stored chunk (with its embedding) into memory for scoring. */
export async function loadAllChunks(): Promise<{ chunks: IndexChunk[]; meta: LanceMeta } | null> {
  const tbl = await openTable();
  if (!tbl) return null;
  try {
    const rows = (await tbl.query().limit(1_000_000).toArray()) as Record<string, unknown>[];
    const chunks = rows.map(fromRow);
    const meta = readMeta() ?? { builtAt: new Date().toISOString() };
    return { chunks, meta };
  } catch {
    return null;
  }
}

/** Lightweight summary for `docs index` without materializing every row. */
export async function indexStats(): Promise<{ built: boolean; builtAt?: string; chunks: number; model?: string }> {
  const tbl = await openTable();
  if (!tbl) return { built: false, chunks: 0 };
  try {
    const count = await tbl.countRows();
    const meta = readMeta();
    return { built: true, builtAt: meta?.builtAt, chunks: count, model: meta?.embeddingModel };
  } catch {
    return { built: false, chunks: 0 };
  }
}

/** Rebuild the whole table from a freshly embedded chunk set (`docs reindex`). */
export async function replaceAllChunks(chunks: IndexChunk[], model: string): Promise<void> {
  const rows = chunks.map(toRow).filter((r): r is LanceRow => r !== null);
  if (rows.length === 0) throw new Error("Cannot build a LanceDB index from chunks without embeddings.");
  const db = await connect();
  await db.createTable(TABLE, rows as unknown as Record<string, unknown>[], { mode: "overwrite" });
  writeMeta({ builtAt: new Date().toISOString(), embeddingModel: model });
}

/** Incrementally append new embedded chunks (just-in-time enrichment). */
export async function addChunks(chunks: IndexChunk[], model: string): Promise<void> {
  const incoming = chunks.map(toRow).filter((r): r is LanceRow => r !== null);
  if (incoming.length === 0) return;
  const tbl = await openTable();
  if (!tbl) {
    // No core table yet — create one from these chunks.
    const db = await connect();
    await db.createTable(TABLE, incoming as unknown as Record<string, unknown>[], { mode: "overwrite" });
    writeMeta({ builtAt: new Date().toISOString(), embeddingModel: model });
    return;
  }
  const existing = new Set(
    ((await tbl.query().select(["id"]).limit(1_000_000).toArray()) as Record<string, unknown>[]).map((r) =>
      String(r.id)
    )
  );
  const additions = incoming.filter((r) => !existing.has(r.id));
  if (additions.length === 0) return;
  await tbl.add(additions as unknown as Record<string, unknown>[]);
  const meta = readMeta();
  writeMeta({ builtAt: new Date().toISOString(), embeddingModel: meta?.embeddingModel ?? model });
}
