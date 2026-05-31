import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { AgentJob } from "../types.js";
import { ensureDataDir, JOBS_FILE, jobLogPath, LOGS_DIR } from "../paths.js";
import { redactJobInput } from "./redact.js";

const MAX_JOBS_RETAINED = 200;
const LOCK_DIR = JOBS_FILE + ".lock";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

/**
 * Cross-process lock based on `mkdir` atomicity. Synchronous: the critical
 * section is tiny (single JSON write) and worker spawn must see the job
 * already persisted, so we accept a short busy-wait under contention.
 */
function withLock<T>(fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch {
      if (Date.now() > deadline) {
        // Stale lock recovery: assume the holder crashed and reclaim it.
        try { rmdirSync(LOCK_DIR); } catch { /* noop */ }
        try { mkdirSync(LOCK_DIR); } catch { /* noop */ }
        break;
      }
      // Tight busy-wait with a noop loop — Node has no sync sleep primitive,
      // but the lock is only held for sub-millisecond windows in practice.
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(LOCK_DIR); } catch { /* noop */ }
  }
}

function loadJobs(): AgentJob[] {
  ensureDataDir();
  if (!existsSync(JOBS_FILE)) {
    return [];
  }
  const raw = readFileSync(JOBS_FILE, "utf-8");
  if (!raw.trim()) {
    return [];
  }
  try {
    return JSON.parse(raw) as AgentJob[];
  } catch {
    return [];
  }
}

function saveJobs(jobs: AgentJob[]): void {
  ensureDataDir();
  const trimmed = jobs.slice(0, MAX_JOBS_RETAINED);
  const evicted = jobs.slice(MAX_JOBS_RETAINED);
  const tmp = JOBS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2), "utf-8");
  renameSync(tmp, JOBS_FILE);
  // best-effort cleanup of evicted job logs
  for (const job of evicted) {
    const log = jobLogPath(job.id);
    try {
      if (existsSync(log)) {
        unlinkSync(log);
      }
    } catch {
      // ignore
    }
  }
}

export function addJob(job: AgentJob): void {
  const redacted: AgentJob = { ...job, input: redactJobInput(job.input) };
  withLock(() => {
    const jobs = loadJobs();
    jobs.unshift(redacted);
    saveJobs(jobs);
  });
}

export function listJobs(limit = 20): AgentJob[] {
  return loadJobs().slice(0, limit);
}

export function getJob(jobId: string): AgentJob | undefined {
  return loadJobs().find((job) => job.id === jobId);
}

export function updateJob(jobId: string, patch: Partial<AgentJob>): AgentJob {
  return withLock(() => {
    const jobs = loadJobs();
    const index = jobs.findIndex((job) => job.id === jobId);

    if (index === -1) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const updated: AgentJob = {
      ...jobs[index],
      ...patch,
      updatedAt: new Date().toISOString()
    };

    jobs[index] = updated;
    saveJobs(jobs);
    return updated;
  });
}

export function getJobLogPath(jobId: string): string {
  ensureDataDir();
  return jobLogPath(jobId);
}

export function getLogsDir(): string {
  ensureDataDir();
  return path.resolve(LOGS_DIR);
}
