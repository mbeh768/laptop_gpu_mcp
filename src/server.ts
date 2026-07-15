import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import {
  cleanupDeadSymlinks,
  createSymlink,
  listCondaEnvs,
  listPythonScripts,
  removeSymlink,
  resolveCondaPython,
  resolveScriptPath,
  PathSecurityError,
} from "./paths.js";
import { runForeground } from "./execRun.js";
import { getJob, listJobs, startJob } from "./jobs.js";
import { getDiagnostics } from "./diagnostics.js";

const GB = 1024 ** 3;
const formatGB = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

export function createServer(): McpServer {
  const server = new McpServer({
    name: "laptop-gpu-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_scripts",
    {
      title: "List runnable Python scripts",
      description:
        `Lists .py files available under the scripts base directory (${config.scriptsBaseDir})` +
        (Object.keys(config.extraScriptRoots).length
          ? ` and under these additional roots (prefix the returned path with the name to run it): ` +
            Object.entries(config.extraScriptRoots)
              .map(([name, dir]) => `${name} -> ${dir}`)
              .join(", ")
          : "") +
        ".",
      inputSchema: {},
    },
    async () => {
      const scripts = listPythonScripts();
      return {
        content: [
          {
            type: "text",
            text: scripts.length ? scripts.join("\n") : "(no .py scripts found)",
          },
        ],
      };
    }
  );

  server.registerTool(
    "run_python",
    {
      title: "Run a Python script",
      description:
        "Executes a Python script from the configured scripts base directory using any conda environment " +
        `found under ${config.condaBaseDir}/envs (currently: ${listCondaEnvs().join(", ") || "none found"}). ` +
        "Runs in the foreground by default and returns stdout/stderr once it finishes. Set background=true " +
        "for long-running jobs (training/inference) to get a job_id back immediately, then poll it with job_status.",
      inputSchema: {
        script: z
          .string()
          .describe(
            'Path to the script. Relative to the scripts base directory by default, e.g. "train.py" or "sub/infer.py". ' +
              "For an additional root, prefix with its name as returned by list_scripts, e.g. " +
              '"laptop_gpu_share/otda-exp/experiments/run_experiment_2.py".'
          ),
        env: z.string().describe(`Conda environment name to run under. One of: ${listCondaEnvs().join(", ") || "none found"}.`),
        args: z.array(z.string()).optional().describe("Optional CLI arguments passed to the script."),
        background: z.boolean().optional().describe("If true, runs the script in the background and returns a job_id immediately instead of blocking."),
        timeoutMs: z.number().optional().describe("Foreground-only: kill the process after this many milliseconds (default 300000)."),
      },
    },
    async ({ script, env, args, background, timeoutMs }) => {
      try {
        const scriptPath = resolveScriptPath(script);
        const pythonBin = resolveCondaPython(env);

        if (background) {
          const job = startJob(pythonBin, scriptPath, script, env, args ?? []);
          return {
            content: [
              {
                type: "text",
                text: `Started background job ${job.id} (pid ${job.pid}). Poll with job_status.`,
              },
            ],
          };
        }

        const result = await runForeground(pythonBin, scriptPath, args ?? [], timeoutMs ?? 300_000);
        const parts = [
          `exit code: ${result.exitCode}${result.timedOut ? " (timed out, killed)" : ""}`,
          `--- stdout ---\n${result.stdout || "(empty)"}`,
          `--- stderr ---\n${result.stderr || "(empty)"}`,
        ];
        return {
          content: [{ type: "text", text: parts.join("\n\n") }],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        const message = err instanceof PathSecurityError ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "job_status",
    {
      title: "Check background job status",
      description: "Checks the status and captured output of a background job started by run_python. Omit job_id to list all known jobs.",
      inputSchema: {
        job_id: z.string().optional().describe("The job id returned by run_python when background=true. Omit to list all jobs."),
      },
    },
    async ({ job_id }) => {
      if (!job_id) {
        const jobs = listJobs();
        if (!jobs.length) {
          return { content: [{ type: "text", text: "No jobs recorded." }] };
        }
        const summary = jobs
          .map((j) => `${j.id}  [${j.status}]  ${j.script} (env=${j.env})  started=${j.startedAt}`)
          .join("\n");
        return { content: [{ type: "text", text: summary }] };
      }

      const job = getJob(job_id);
      if (!job) {
        return { content: [{ type: "text", text: `No job found with id ${job_id}` }], isError: true };
      }
      const parts = [
        `job: ${job.id}`,
        `script: ${job.script} (env=${job.env})`,
        `status: ${job.status}`,
        `pid: ${job.pid}`,
        `started: ${job.startedAt}`,
        `finished: ${job.finishedAt ?? "-"}`,
        `exit code: ${job.exitCode ?? "-"}`,
        `--- stdout ---\n${job.stdout || "(empty so far)"}`,
        `--- stderr ---\n${job.stderr || "(empty so far)"}`,
      ];
      return { content: [{ type: "text", text: parts.join("\n\n") }] };
    }
  );

  server.registerTool(
    "create_symlink",
    {
      title: "Create a local symlink to shared data",
      description:
        `Creates a symlink under the local links directory (${config.linksBaseDir}) pointing at a file or ` +
        "directory found in one of the configured script/data roots (same roots and prefix rules as " +
        'run_python\'s "script" argument, e.g. "laptop_gpu_share/otda-exp/data"). Useful for tools (e.g. ' +
        "Slideflow) that require data to live under a local-looking path rather than a network share. Note " +
        "this only aliases the path — the underlying bytes still live wherever the target actually is, so it " +
        "won't help if the real problem is the storage medium itself (e.g. mmap/locking issues over a network " +
        "filesystem) rather than the path shape.",
      inputSchema: {
        target: z
          .string()
          .describe(
            'Path to the file or directory to link to, using the same root/prefix rules as run_python\'s ' +
              '"script" argument, e.g. "laptop_gpu_share/otda-exp/data".'
          ),
        linkName: z
          .string()
          .describe(`Relative path (under ${config.linksBaseDir}) where the symlink should be created, e.g. "otda_data".`),
        overwrite: z
          .boolean()
          .optional()
          .describe("If true, replace an existing symlink at linkName. Default false. Never overwrites a real file/directory."),
      },
    },
    async ({ target, linkName, overwrite }) => {
      try {
        const result = createSymlink(target, linkName, { overwrite });
        return { content: [{ type: "text", text: `Created symlink ${result.link} -> ${result.target}` }] };
      } catch (err) {
        const message = err instanceof PathSecurityError ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "remove_symlink",
    {
      title: "Remove a local data symlink",
      description: `Removes a symlink previously created under the local links directory (${config.linksBaseDir}). Refuses to remove anything that isn't a symlink.`,
      inputSchema: {
        linkName: z.string().describe(`Relative path (under ${config.linksBaseDir}) of the symlink to remove, e.g. "otda_data".`),
      },
    },
    async ({ linkName }) => {
      try {
        const removed = removeSymlink(linkName);
        return { content: [{ type: "text", text: `Removed symlink ${removed}` }] };
      } catch (err) {
        const message = err instanceof PathSecurityError ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "cleanup_symlinks",
    {
      title: "Clean up dead data symlinks",
      description:
        `Scans the local links directory (${config.linksBaseDir}) for symlinks whose target no longer exists ` +
        "(e.g. the shared drive was reorganized or the linked file/dir was deleted) and removes them, so the " +
        "drive doesn't accumulate dead links over time.",
      inputSchema: {},
    },
    async () => {
      try {
        const removed = cleanupDeadSymlinks();
        return {
          content: [
            {
              type: "text",
              text: removed.length ? `Removed ${removed.length} dead link(s):\n${removed.join("\n")}` : "No dead links found.",
            },
          ],
        };
      } catch (err) {
        const message = err instanceof PathSecurityError ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "system_status",
    {
      title: "System diagnostics (storage, RAM, CPU, GPU)",
      description:
        "Reports current storage availability for the configured script/data roots, system RAM usage, CPU " +
        "utilization (cores, load average, and a short-sampled busy%), and GPU utilization/memory/temperature " +
        "(via nvidia-smi, if present). Useful for checking whether the machine has headroom before starting " +
        "a job, or for checking on a job already in progress.",
      inputSchema: {},
    },
    async () => {
      const diag = await getDiagnostics();

      const diskLines = diag.disks.length
        ? diag.disks.map(
            (d) =>
              `  ${d.label} (${d.path}): ${formatGB(d.freeBytes)} free / ${formatGB(d.totalBytes)} total (${d.usedPercent}% used)`
          )
        : ["  (no disk info available)"];

      const ramLine = `  ${formatGB(diag.ram.freeBytes)} free / ${formatGB(diag.ram.totalBytes)} total (${diag.ram.usedPercent}% used)`;

      const cpuLine =
        `  ${diag.cpu.cores} cores, ${diag.cpu.currentUtilizationPercent ?? "?"}% busy (sampled), ` +
        `load average (1/5/15m): ${diag.cpu.loadavg.map((n) => n.toFixed(2)).join(" / ")}`;

      const gpuLines = diag.gpus.length
        ? diag.gpus.map(
            (g) =>
              `  ${g.name}: ${g.utilizationPercent}% util, ${g.memoryUsedMB}/${g.memoryTotalMB} MB used, ${g.temperatureC}°C`
          )
        : [`  (${diag.gpuError ?? "no GPU info available"})`];

      const text = [
        "Storage:",
        ...diskLines,
        "",
        "RAM:",
        ramLine,
        "",
        "CPU:",
        cpuLine,
        "",
        "GPU:",
        ...gpuLines,
      ].join("\n");

      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}
