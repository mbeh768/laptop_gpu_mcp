import { spawn } from "node:child_process";
import { config } from "./config.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

const MAX_OUTPUT_CHARS = 500_000;

export function runForeground(
  pythonBin: string,
  scriptPath: string,
  args: string[],
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(pythonBin, [scriptPath, ...args], {
      cwd: config.scriptsBaseDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString();
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n[spawn error] ${err.message}`, exitCode: null, signal: null, timedOut });
    });
  });
}
