import path from 'node:path';
import { access, realpath } from 'node:fs/promises';

export class SandboxViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxViolation';
    this.code = 'SANDBOX_VIOLATION';
  }
}

export function createPathSandbox(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  function assertInside(candidate) {
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(rootWithSeparator)) {
      throw new SandboxViolation(`Path is outside the workspace: ${candidate}`);
    }
    return resolved;
  }

  function resolve(userPath = '.') {
    if (typeof userPath !== 'string' || userPath.includes('\0')) {
      throw new SandboxViolation('Path must be a valid string.');
    }
    return assertInside(path.resolve(root, userPath));
  }

  async function resolveExisting(userPath = '.') {
    const resolved = resolve(userPath);
    const canonical = await realpath(resolved);
    return assertInside(canonical);
  }

  async function resolveForWrite(userPath) {
    const resolved = resolve(userPath);
    let ancestor = path.dirname(resolved);
    while (true) {
      try {
        await access(ancestor);
        const canonicalAncestor = await realpath(ancestor);
        assertInside(canonicalAncestor);
        return resolved;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new SandboxViolation('Could not resolve a safe parent directory.');
        ancestor = parent;
      }
    }
  }

  function relative(absolutePath) {
    return path.relative(root, absolutePath).split(path.sep).join('/') || '.';
  }

  return { root, resolve, resolveExisting, resolveForWrite, assertInside, relative };
}
