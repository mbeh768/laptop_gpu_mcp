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
 * Resolves a user-supplied path against the configured script/data roots and
 * rejects anything that escapes all of them (symlinks included). Extra roots
 * are addressed as "<name>/rest/of/path"; the default root is addressed with
 * no prefix, same as before extra roots existed. Unlike resolveScriptPath,
 * this accepts any existing file or directory, not just .py files.
 *
 * If relativePath's first segment matches a configured extra root's name,
 * it is resolved against *only* that root — it never silently falls through
 * to interpreting the same string as a literal subpath of the default root.
 * Without this, a coincidental (or since-created) directory under the
 * default root sharing an extra root's name would shadow the intended root.
 */
export function resolveDataPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathSecurityError("Path must be relative to a configured script/data root.");
  }

  const namedRoot = getScriptRoots().find(
    (root) => root.name && (relativePath === root.name || relativePath.startsWith(root.name + "/"))
  );
  if (namedRoot) {
    const rest = relativePath === namedRoot.name ? "" : relativePath.slice(namedRoot.name.length + 1);
    const resolved = resolveWithinRoot(namedRoot, rest);
    if (resolved === null) {
      throw new PathSecurityError(`Path not found in root "${namedRoot.name}": ${relativePath}`);
    }
    return resolved;
  }

  const defaultRoot = getScriptRoots().find((root) => root.name === "")!;
  const resolved = resolveWithinRoot(defaultRoot, relativePath);
  if (resolved === null) {
    throw new PathSecurityError(`Path not found in any configured root: ${relativePath}`);
  }
  return resolved;
}

export function resolveScriptPath(relativePath: string): string {
  const resolved = resolveDataPath(relativePath);
  if (!resolved.endsWith(".py")) {
    throw new PathSecurityError("Only .py files may be executed.");
  }
  return resolved;
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

/**
 * Resolves a path under linksBaseDir, defending against both literal ../
 * traversal and symlinks in already-existing intermediate directories that
 * would otherwise redirect the write outside linksBaseDir. Does not care
 * whether the final path itself exists yet — callers decide that.
 */
function resolveLinkPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathSecurityError("Link path must be relative to the links base directory.");
  }
  const resolved = path.resolve(config.linksBaseDir, relativePath);
  const base = config.linksBaseDir + path.sep;
  if (!resolved.startsWith(base)) {
    throw new PathSecurityError("Link path escapes the configured links base directory.");
  }

  fs.mkdirSync(config.linksBaseDir, { recursive: true });
  const realBase = fs.realpathSync(config.linksBaseDir) + path.sep;

  // Walk up from the *parent* directory (never the leaf itself — if the leaf
  // already exists as a symlink, it's expected to point outside linksBaseDir;
  // that's the whole point of this tool, and is not an escape) to the
  // deepest already-existing ancestor, and realpath that. This catches a
  // symlink planted in an intermediate directory that would otherwise let a
  // literal (pre-realpath) path pass the startsWith(base) check above while
  // actually writing outside linksBaseDir.
  let existingAncestor = path.dirname(resolved);
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor) + path.sep;
  if (!realAncestor.startsWith(realBase)) {
    throw new PathSecurityError(
      "Link path escapes the configured links base directory (symlink in an intermediate directory)."
    );
  }

  return resolved;
}

/**
 * Creates a symlink under linksBaseDir pointing at a file or directory found
 * in one of the configured script/data roots. Refuses to clobber anything
 * already at the destination unless overwrite is true, and even then only
 * ever replaces an existing symlink — never a real file or directory.
 */
export function createSymlink(
  targetRelative: string,
  linkRelative: string,
  opts?: { overwrite?: boolean }
): { target: string; link: string } {
  const targetResolved = resolveDataPath(targetRelative);
  const linkResolved = resolveLinkPath(linkRelative);

  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(linkResolved);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  if (existing) {
    if (!opts?.overwrite) {
      throw new PathSecurityError(
        `Link path already exists: ${linkRelative} (pass overwrite=true to replace it).`
      );
    }
    if (!existing.isSymbolicLink()) {
      throw new PathSecurityError(`Refusing to overwrite a non-symlink at: ${linkRelative}`);
    }
    fs.unlinkSync(linkResolved);
  }

  fs.mkdirSync(path.dirname(linkResolved), { recursive: true });
  const targetStat = fs.statSync(targetResolved);
  fs.symlinkSync(targetResolved, linkResolved, targetStat.isDirectory() ? "dir" : "file");
  return { target: targetResolved, link: linkResolved };
}

/** Removes a symlink under linksBaseDir. Refuses to remove anything that isn't a symlink. */
export function removeSymlink(linkRelative: string): string {
  const linkResolved = resolveLinkPath(linkRelative);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(linkResolved);
  } catch (err: any) {
    if (err.code === "ENOENT") throw new PathSecurityError(`Link not found: ${linkRelative}`);
    throw err;
  }
  if (!stat.isSymbolicLink()) {
    throw new PathSecurityError(`Refusing to remove a non-symlink at: ${linkRelative}`);
  }
  fs.unlinkSync(linkResolved);
  return linkResolved;
}

/**
 * Walks linksBaseDir and removes any symlink whose target no longer exists
 * (e.g. the shared drive was reorganized or unmounted, or the link was
 * created against something later deleted). Returns the relative paths
 * removed, so callers/tools can report what got cleaned up.
 */
export function cleanupDeadSymlinks(): string[] {
  const base = config.linksBaseDir;
  if (!fs.existsSync(base)) return [];
  const removed: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // existsSync follows symlinks and returns false if the target is missing.
        if (!fs.existsSync(full)) {
          fs.unlinkSync(full);
          removed.push(path.relative(base, full));
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  }
  walk(base);
  return removed;
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
