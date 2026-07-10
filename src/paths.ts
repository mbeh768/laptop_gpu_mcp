import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export class PathSecurityError extends Error {}

/**
 * Resolves a user-supplied relative script path against the scripts base
 * directory and rejects anything that escapes it (symlinks included).
 */
export function resolveScriptPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathSecurityError("Script path must be relative to the scripts base directory.");
  }
  const resolved = path.resolve(config.scriptsBaseDir, relativePath);
  const base = config.scriptsBaseDir + path.sep;
  if (!resolved.startsWith(base)) {
    throw new PathSecurityError("Script path escapes the configured scripts base directory.");
  }
  if (!fs.existsSync(resolved)) {
    throw new PathSecurityError(`Script not found: ${relativePath}`);
  }
  const real = fs.realpathSync(resolved);
  if (!(real + path.sep).startsWith(base) && real !== resolved) {
    // realpath resolves symlinks; make sure the target still lives inside base.
    if (!real.startsWith(base)) {
      throw new PathSecurityError("Script path resolves outside the scripts base directory (symlink escape).");
    }
  }
  if (!resolved.endsWith(".py")) {
    throw new PathSecurityError("Only .py files may be executed.");
  }
  return resolved;
}

export function resolveCondaPython(envName: string): string {
  if (!config.allowedEnvs.includes(envName)) {
    throw new PathSecurityError(
      `Conda env "${envName}" is not in the allowed list: ${config.allowedEnvs.join(", ")}`
    );
  }
  const pythonBin = path.join(config.condaBaseDir, "envs", envName, "bin", "python");
  if (!fs.existsSync(pythonBin)) {
    throw new PathSecurityError(`Python binary not found for env "${envName}" at ${pythonBin}`);
  }
  return pythonBin;
}

export function listPythonScripts(): string[] {
  const results: string[] = [];
  const base = config.scriptsBaseDir;
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        results.push(path.relative(base, full));
      }
    }
  }
  if (fs.existsSync(base)) walk(base);
  return results.sort();
}
