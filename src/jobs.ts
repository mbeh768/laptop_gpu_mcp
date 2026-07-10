import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export type JobStatus = "running" | "exited" | "error";

export interface Job {
  id: string;
  script: string;
  env: string;
  args: string[];
  pid: number;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string | null;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER_CHARS = 2_000_000;
const jobs = new Map<string, Job>();

function appendCapped(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > MAX_BUFFER_CHARS
    ? combined.slice(combined.length - MAX_BUFFER_CHARS)
    : combined;
}

export function startJob(
  pythonBin: string,
  scriptPath: string,
  scriptRel: string,
  env: string,
  args: string[]
): Job {
  const child = spawn(pythonBin, [scriptPath, ...args], {
    cwd: config.scriptsBaseDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const job: Job = {
    id: randomUUID(),
    script: scriptRel,
    env,
    args,
    pid: child.pid ?? -1,
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stdout: "",
    stderr: "",
  };
  jobs.set(job.id, job);

  child.stdout?.on("data", (d) => {
    job.stdout = appendCapped(job.stdout, d.toString());
  });
  child.stderr?.on("data", (d) => {
    job.stderr = appendCapped(job.stderr, d.toString());
  });
  child.on("exit", (code, signal) => {
    job.status = code === 0 ? "exited" : "error";
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = new Date().toISOString();
  });
  child.on("error", (err) => {
    job.status = "error";
    job.stderr = appendCapped(job.stderr, `\n[spawn error] ${err.message}`);
    job.finishedAt = new Date().toISOString();
  });
  child.unref();

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function pruneOldJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - Date.parse(job.finishedAt) > config.jobRetentionMs) {
      jobs.delete(id);
    }
  }
}
setInterval(pruneOldJobs, 60 * 60 * 1000).unref();
