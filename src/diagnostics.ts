import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { config } from "./config.js";

export interface DiskUsage {
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface GpuStatus {
  name: string;
  utilizationPercent: number;
  memoryUsedMB: number;
  memoryTotalMB: number;
  temperatureC: number;
}

export interface Diagnostics {
  disks: DiskUsage[];
  ram: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number };
  cpu: { cores: number; loadavg: [number, number, number]; currentUtilizationPercent: number | null };
  gpus: GpuStatus[];
  gpuError?: string;
}

function diskUsageFor(label: string, dir: string): DiskUsage | null {
  try {
    const stats = fs.statfsSync(dir);
    const totalBytes = stats.blocks * stats.bsize;
    // bavail (not bfree) is space available to an unprivileged process, excluding root-reserved blocks.
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      label,
      path: dir,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return null;
  }
}

function getDiskUsages(): DiskUsage[] {
  const roots: Record<string, string> = {
    scripts: config.scriptsBaseDir,
    conda: config.condaBaseDir,
    links: config.linksBaseDir,
    ...config.extraScriptRoots,
  };
  const seenDirs = new Set<string>();
  const results: DiskUsage[] = [];
  for (const [label, dir] of Object.entries(roots)) {
    if (seenDirs.has(dir)) continue; // dedupe roots that share a filesystem/mount
    seenDirs.add(dir);
    const usage = diskUsageFor(label, dir);
    if (usage) results.push(usage);
  }
  return results;
}

function cpuTimesSnapshot() {
  return os.cpus().map((c) => c.times);
}

/** Samples CPU busy% over a short window rather than reporting a since-boot cumulative average. */
function sampleCpuUtilization(sampleMs = 200): Promise<number | null> {
  return new Promise((resolve) => {
    const start = cpuTimesSnapshot();
    setTimeout(() => {
      try {
        const end = cpuTimesSnapshot();
        let idleDelta = 0;
        let totalDelta = 0;
        for (let i = 0; i < start.length; i++) {
          const s = start[i];
          const e = end[i];
          const sTotal = s.user + s.nice + s.sys + s.idle + s.irq;
          const eTotal = e.user + e.nice + e.sys + e.idle + e.irq;
          idleDelta += e.idle - s.idle;
          totalDelta += eTotal - sTotal;
        }
        resolve(totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 1000) / 10 : null);
      } catch {
        resolve(null);
      }
    }, sampleMs);
  });
}

function getRamUsage() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
  };
}

// systemd (unlike an interactive login shell) doesn't source .bashrc/.profile,
// so PATH additions like WSL's /usr/lib/wsl/lib (where nvidia-smi lives under
// WSL's GPU passthrough) aren't present. Try common locations explicitly
// before falling back to a bare PATH lookup (native Linux installs typically
// already have nvidia-smi on PATH).
const NVIDIA_SMI_CANDIDATES = ["/usr/lib/wsl/lib/nvidia-smi", "/usr/bin/nvidia-smi", "nvidia-smi"];

function resolveNvidiaSmiBin(): string {
  for (const candidate of NVIDIA_SMI_CANDIDATES) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
  }
  return "nvidia-smi";
}

function getGpuStatus(): Promise<{ gpus: GpuStatus[]; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      resolveNvidiaSmiBin(),
      [
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve({ gpus: [], error: `nvidia-smi unavailable: ${err.message}` });
          return;
        }
        const gpus: GpuStatus[] = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name, util, memUsed, memTotal, temp] = line.split(",").map((s) => s.trim());
            return {
              name,
              utilizationPercent: Number(util),
              memoryUsedMB: Number(memUsed),
              memoryTotalMB: Number(memTotal),
              temperatureC: Number(temp),
            };
          });
        resolve({ gpus });
      }
    );
  });
}

export async function getDiagnostics(): Promise<Diagnostics> {
  const [cpuUtilizationPercent, gpuResult] = await Promise.all([sampleCpuUtilization(), getGpuStatus()]);
  return {
    disks: getDiskUsages(),
    ram: getRamUsage(),
    cpu: {
      cores: os.cpus().length,
      loadavg: os.loadavg() as [number, number, number],
      currentUtilizationPercent: cpuUtilizationPercent,
    },
    gpus: gpuResult.gpus,
    gpuError: gpuResult.error,
  };
}
