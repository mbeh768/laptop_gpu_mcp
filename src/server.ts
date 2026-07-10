import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.js";
import { listPythonScripts, resolveCondaPython, resolveScriptPath, PathSecurityError } from "./paths.js";
import { runForeground } from "./execRun.js";
import { getJob, listJobs, startJob } from "./jobs.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "laptop-gpu-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_scripts",
    {
      title: "List runnable Python scripts",
      description: `Lists .py files available under the scripts base directory (${config.scriptsBaseDir}).`,
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
        "Executes a Python script from the configured scripts base directory using one of the allowed " +
        `conda environments (${config.allowedEnvs.join(", ")}). Runs in the foreground by default and returns ` +
        "stdout/stderr once it finishes. Set background=true for long-running jobs (training/inference) to " +
        "get a job_id back immediately, then poll it with job_status.",
      inputSchema: {
        script: z.string().describe('Path to the script, relative to the scripts base directory, e.g. "train.py" or "sub/infer.py".'),
        env: z.string().describe(`Conda environment name to run under. One of: ${config.allowedEnvs.join(", ")}.`),
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

  return server;
}
