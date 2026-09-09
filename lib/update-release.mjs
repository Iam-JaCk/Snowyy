import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';

export function parseReleases(contents, { allowUrls = false } = {}) {
  const lines = contents.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('RELEASES is empty.');
  const names = new Set();
  return lines.map((line) => {
    const match = line.trim().match(/^([a-f\d]{40})\s+(\S+)\s+(\d+)$/i);
    if (!match) throw new Error('Invalid Squirrel RELEASES entry.');
    const [, sha1, name, sizeText] = match;
    const localName = /^[a-z\d][a-z\d_.-]*\.nupkg$/i.test(name);
    let allowedUrl = false;
    if (allowUrls && /^https:\/\//.test(name)) {
      const parsed = new URL(name);
      allowedUrl = !parsed.username && !parsed.password && parsed.pathname.endsWith('.nupkg');
    }
    if (!localName && !allowedUrl) throw new Error('RELEASES must reference safe .nupkg filenames.');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid package size in RELEASES.');
    if (names.has(name.toLowerCase())) throw new Error('Duplicate package in RELEASES.');
    names.add(name.toLowerCase());
    return { sha1: sha1.toLowerCase(), name, size };
  });
}

async function verifyPackage(filePath, release) {
  if ((await stat(filePath)).size !== release.size) throw new Error(`Package size mismatch: ${release.name}`);
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (hash.digest('hex') !== release.sha1) throw new Error(`Package hash mismatch: ${release.name}`);
}

async function atomicCopy(source, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function stageUpdate({ artifactRoot, feedRoot, version }) {
  const releasesPath = path.join(artifactRoot, 'RELEASES');
  const releasesBytes = await readFile(releasesPath);
  const releases = parseReleases(releasesBytes.toString('utf8'));
  const expected = `snowyy-${version}-full.nupkg`;
  if (!releases.some(({ name }) => name === expected)) throw new Error(`RELEASES does not reference ${expected}. Run npm run make first.`);
  for (const release of releases) await verifyPackage(path.join(artifactRoot, release.name), release);
  const installer = path.join(artifactRoot, 'Snowyy-Setup.exe');
  if (!(await stat(installer)).isFile()) throw new Error('Snowyy-Setup.exe is missing.');
  await mkdir(feedRoot, { recursive: true });
  // A versioned package is immutable once clients can discover it.
  for (const release of releases) {
    const destination = path.join(feedRoot, release.name);
    try {
      await verifyPackage(destination, release);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Published package differs: ${release.name}. Bump the version before publishing again.`);
    }
  }
  for (const release of releases) await atomicCopy(path.join(artifactRoot, release.name), path.join(feedRoot, release.name));
  await atomicCopy(installer, path.join(feedRoot, 'Snowyy-Setup.exe'));
  // Expose the manifest atomically, only after every referenced payload is ready.
  const temporary = path.join(feedRoot, `RELEASES.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, releasesBytes);
    await rename(temporary, path.join(feedRoot, 'RELEASES'));
  } finally {
    await rm(temporary, { force: true });
  }
  return { releasesBytes, packages: releases.map(({ name }) => name) };
}
