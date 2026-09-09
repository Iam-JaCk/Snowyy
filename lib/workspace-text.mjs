import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { toolError } from './tool-contracts.mjs';

export const MAX_TEXT_FILE_BYTES = 2_000_000;
export const textHash = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

export async function readWorkspaceText(absolute, userPath) {
  const info = await lstat(absolute);
  if (!info.isFile()) throw toolError('NOT_A_FILE', `${userPath} is not a file.`, 'Use list_directory to inspect directories.');
  if (info.size > MAX_TEXT_FILE_BYTES) throw toolError('FILE_TOO_LARGE', `${userPath} exceeds the ${MAX_TEXT_FILE_BYTES} byte text-file limit.`, 'Use an approved run_command to inspect a bounded portion of this file.');
  const bytes = await readFile(absolute);
  if (bytes.length > MAX_TEXT_FILE_BYTES) throw toolError('FILE_TOO_LARGE', `${userPath} grew beyond the text-file limit.`, 'Read a bounded portion with an approved command.');
  const content = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
    throw toolError('BINARY_FILE', `${userPath} is binary or is not valid UTF-8.`, 'Use a tool appropriate for this file format; text edits are unavailable.');
  }
  return content;
}

// A trailing newline terminates the last line; it does not add a phantom line.
export function lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length - 1; i += 1) if (content[i] === '\n') starts.push(i + 1);
  return starts;
}
