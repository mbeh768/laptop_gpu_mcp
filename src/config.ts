import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// config.json lives at the project root (one level up from src/ or dist/).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(moduleDir, "..", "config.json");

interface FileConfig {
  scriptsBaseDir?: string;
  condaBaseDir?: string;
  extraScriptRoots?: Record<string, string>;
  linksBaseDir?: string;
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

// EXTRA_SCRIPT_ROOTS env format: "name1=/path/one,name2=/path/two"
const envExtraScriptRoots = process.env.EXTRA_SCRIPT_ROOTS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .reduce<Record<string, string>>((acc, pair) => {
    const idx = pair.indexOf("=");
    if (idx > 0) acc[pair.slice(0, idx)] = pair.slice(idx + 1);
    return acc;
  }, {});

// Precedence for every setting: environment variable > config.json > built-in
// placeholder default. Copy config.example.json to config.json and edit it, or
// pass env vars at startup — either works.
export const config = {
  scriptsBaseDir: path.resolve(
    process.env.SCRIPTS_BASE_DIR ?? fileConfig.scriptsBaseDir ?? "/home/youruser/scripts"
  ),
  condaBaseDir: path.resolve(
    process.env.CONDA_BASE_DIR ?? fileConfig.condaBaseDir ?? "/home/youruser/miniconda3"
  ),
  // Additional named script roots, addressable as "<name>/<relative path>" in
  // run_python. Each is a separate trusted tree, sandboxed the same way as
  // scriptsBaseDir (no traversal or symlink escape out of its own root).
  extraScriptRoots: Object.fromEntries(
    Object.entries(envExtraScriptRoots ?? fileConfig.extraScriptRoots ?? {}).map(([name, dir]) => [
      name,
      path.resolve(dir),
    ])
  ),
  // Directory where create_symlink is allowed to create links. Kept separate
  // from scriptsBaseDir/extraScriptRoots since those are read-from roots,
  // this is the one write-to location for the symlink tools.
  linksBaseDir: path.resolve(
    process.env.LINKS_BASE_DIR ?? fileConfig.linksBaseDir ?? "/home/youruser/local_data"
  ),
  host: process.env.MCP_HOST ?? fileConfig.host ?? "0.0.0.0",
  port: Number(process.env.MCP_PORT ?? fileConfig.port ?? 8420),
  // Jobs finished more than this long ago are pruned from memory.
  jobRetentionMs: Number(
    process.env.JOB_RETENTION_MS ?? fileConfig.jobRetentionMs ?? 24 * 60 * 60 * 1000
  ),
};
