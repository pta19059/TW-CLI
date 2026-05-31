import { runWorkerJob } from "./workerCore.js";

function parseArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function run(): Promise<void> {
  const jobId = parseArg("--job-id");

  if (!jobId) {
    throw new Error("Missing --job-id argument");
  }

  await runWorkerJob(jobId);
}

void run();
