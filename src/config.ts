import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.json lives at the project root (one level up from src/ or dist/).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(moduleDir, "..", "config.json");

interface FileConfig {
  scriptsBaseDir?: string;
  condaBaseDir?: string;
  allowedEnvs?: string[];
  host?: string;
  port?: number;
  jobRetentionMs?: number;
}

let fileConfig: FileConfig = {};
if (fs.existsSync(configPath)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`Failed to parse config.json at ${configPath}:`, err);
  }
}

// Precedence for every setting: environment variable > config.json > built-in
// placeholder default. Copy config.example.json to config.json and edit it, or
// pass env vars at startup — either works.
const envAllowed = process.env.ALLOWED_CONDA_ENVS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  scriptsBaseDir: path.resolve(
    process.env.SCRIPTS_BASE_DIR ?? fileConfig.scriptsBaseDir ?? "/home/youruser/scripts"
  ),
  condaBaseDir: path.resolve(
    process.env.CONDA_BASE_DIR ?? fileConfig.condaBaseDir ?? "/home/youruser/miniconda3"
  ),
  allowedEnvs: envAllowed ?? fileConfig.allowedEnvs ?? ["env1", "env2"],
  host: process.env.MCP_HOST ?? fileConfig.host ?? "0.0.0.0",
  port: Number(process.env.MCP_PORT ?? fileConfig.port ?? 8420),
  // Jobs finished more than this long ago are pruned from memory.
  jobRetentionMs: Number(
    process.env.JOB_RETENTION_MS ?? fileConfig.jobRetentionMs ?? 24 * 60 * 60 * 1000
  ),
};
