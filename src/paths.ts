import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export class PathSecurityError extends Error {}

interface ScriptRoot {
  /** Empty string for the default (unprefixed) root. */
  name: string;
  dir: string;
}

function getScriptRoots(): ScriptRoot[] {
  return [
    { name: "", dir: config.scriptsBaseDir },
    ...Object.entries(config.extraScriptRoots).map(([name, dir]) => ({ name, dir })),
  ];
}

/**
 * Resolves a single script path against a single root, enforcing that the
 * result (symlinks included) stays inside that root. Returns null if the
 * path doesn't exist under this root, so callers can fall through to the
 * next configured root.
 */
function resolveWithinRoot(root: ScriptRoot, relativePath: string): string | null {
  const resolved = path.resolve(root.dir, relativePath);
  const base = root.dir + path.sep;
  if (!resolved.startsWith(base)) return null;
  if (!fs.existsSync(resolved)) return null;
  const real = fs.realpathSync(resolved);
  if (real !== resolved && !(real + path.sep).startsWith(base)) return null;
  return resolved;
}

/**
 * Resolves a user-supplied script path against the configured script roots
 * and rejects anything that escapes all of them (symlinks included). Extra
 * roots are addressed as "<name>/rest/of/path"; the default root is
 * addressed with no prefix, same as before extra roots existed.
 */
export function resolveScriptPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathSecurityError("Script path must be relative to a configured script root.");
  }

  for (const root of getScriptRoots()) {
    let rest = relativePath;
    if (root.name) {
      const prefix = root.name + "/";
      if (!relativePath.startsWith(prefix)) continue;
      rest = relativePath.slice(prefix.length);
    }
    const resolved = resolveWithinRoot(root, rest);
    if (resolved === null) continue;
    if (!resolved.endsWith(".py")) {
      throw new PathSecurityError("Only .py files may be executed.");
    }
    return resolved;
  }

  throw new PathSecurityError(`Script not found in any configured root: ${relativePath}`);
}

/**
 * Lists every conda environment found under condaBaseDir/envs (i.e. every
 * directory with a bin/python inside it).
 */
export function listCondaEnvs(): string[] {
  const envsBase = path.join(config.condaBaseDir, "envs");
  if (!fs.existsSync(envsBase)) return [];
  return fs
    .readdirSync(envsBase, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(envsBase, entry.name, "bin", "python")))
    .map((entry) => entry.name)
    .sort();
}

export function resolveCondaPython(envName: string): string {
  const envsBase = path.join(config.condaBaseDir, "envs") + path.sep;
  const resolvedEnvDir = path.resolve(config.condaBaseDir, "envs", envName);
  if (!resolvedEnvDir.startsWith(envsBase)) {
    throw new PathSecurityError("Conda env name escapes the configured envs directory.");
  }
  const pythonBin = path.join(resolvedEnvDir, "bin", "python");
  if (!fs.existsSync(pythonBin)) {
    throw new PathSecurityError(`Python binary not found for env "${envName}" at ${pythonBin}`);
  }
  return pythonBin;
}

export function listPythonScripts(): string[] {
  const results: string[] = [];
  for (const root of getScriptRoots()) {
    const prefix = root.name ? root.name + "/" : "";
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".py")) {
          results.push(prefix + path.relative(root.dir, full));
        }
      }
    }
    if (fs.existsSync(root.dir)) walk(root.dir);
  }
  return results.sort();
}
