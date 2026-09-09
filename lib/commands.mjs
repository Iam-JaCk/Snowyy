import path from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { toolError } from './tool-contracts.mjs';

export const ALLOWED_EXECUTABLES = ['node', 'npm', 'npx', 'git', 'rg'];
const OUTPUT_LIMIT = 30_000;
const processControlScript = fileURLToPath(new URL('../scripts/control-process.ps1', import.meta.url));

async function controlProcess(pid, action) {
  if (process.platform !== 'win32') {
    const signal = action === 'pause' ? 'SIGSTOP' : 'SIGCONT';
    try { process.kill(-pid, signal); } catch { process.kill(pid, signal); }
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', processControlScript,
      '-ProcessId', String(pid), '-Action', action
    ], { windowsHide: true });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(errors.trim() || `Could not ${action} process ${pid}.`)));
  });
}

export async function resolveCommand(executable, args = [], env = process.env) {
  if (!ALLOWED_EXECUTABLES.includes(executable)) throw toolError('INVALID_ARGUMENTS', `Executable is not allowed: ${executable}`, 'Choose an executable listed in the tool schema.');
  if (args.some((arg) => ['&&', '||', '|', ';', '>', '>>', '<', '2>'].includes(arg))) {
    throw toolError('INVALID_ARGUMENTS', 'Shell operators are not supported in args.', 'Call run_command separately for each command. Pass program options as separate array entries.');
  }
  if (executable === 'node') return { command: process.execPath, args };
  if (!['npm', 'npx'].includes(executable)) return { command: executable, args };
  const cli = `${executable}-cli.js`;
  const directories = [path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)];
  const candidates = [];
  if (env.npm_execpath) candidates.push(path.join(path.dirname(env.npm_execpath), cli));
  for (const directory of directories) {
    candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', cli));
    candidates.push(path.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', cli));
    if (process.platform !== 'win32') {
      try { candidates.push(await realpath(path.join(directory, executable))); } catch {}
    }
  }
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return { command: process.execPath, args: [candidate, ...args] };
    } catch {}
  }
  throw toolError('COMMAND_NOT_FOUND', `${executable} was not found.`, 'Install Node.js with npm and ensure it is on PATH, then restart Snowyy.');
}

function outputBuffer() {
  let head = '';
  let tail = '';
  let length = 0;
  const decoder = new StringDecoder('utf8');
  const append = (text) => {
    length += text.length;
    if (head.length < OUTPUT_LIMIT / 2) {
      const take = OUTPUT_LIMIT / 2 - head.length;
      head += text.slice(0, take);
      text = text.slice(take);
    }
    tail = (tail + text).slice(-OUTPUT_LIMIT / 2);
  };
  return {
    append: (chunk) => append(decoder.write(chunk)),
    finish: () => append(decoder.end()),
    get truncated() { return length > OUTPUT_LIMIT; },
    get text() { return head + (length > OUTPUT_LIMIT ? '\n... output truncated ...\n' : '') + tail; }
  };
}

export async function runWorkspaceCommand(sandbox, { executable, args = [], cwd = '.', timeout_ms: timeoutMs = 20_000 }, { signal, onCommandStart, onCommandState, onCommandOutput } = {}) {
  signal?.throwIfAborted();
  const absoluteCwd = await sandbox.resolveExisting(cwd);
  if (!(await stat(absoluteCwd)).isDirectory()) throw toolError('NOT_A_DIRECTORY', 'cwd must be a directory.', 'Use list_directory to choose a working directory.');
  const invocation = await resolveCommand(executable, args);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: absoluteCwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
    });
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    let timedOut = false;
    let aborted = false;
    let stoppedByUser = false;
    let stopped = false;
    let commandState = 'running';
    let remainingMs = timeoutMs;
    let timerStartedAt = Date.now();
    let timer;
    let killTimer;
    const emitState = (extra = {}) => onCommandState?.({ state: commandState, pid: child.pid, ...extra });
    const stop = () => {
      if (stopped || !child.pid) return;
      stopped = true;
      commandState = 'stopping';
      emitState();
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
        killTimer.unref();
      }
    };
    const abort = () => { aborted = true; stop(); };
    const armTimer = () => {
      timerStartedAt = Date.now();
      timer = setTimeout(() => { timedOut = true; stop(); }, remainingMs);
      timer.unref?.();
    };
    const control = async (action) => {
      if (action === 'stop') {
        stoppedByUser = true;
        stop();
        return { state: commandState };
      }
      if (action === 'pause') {
        if (commandState !== 'running') throw new Error(`Command is ${commandState}; it cannot be paused.`);
        await controlProcess(child.pid, 'pause');
        remainingMs = Math.max(remainingMs - (Date.now() - timerStartedAt), 1_000);
        clearTimeout(timer);
        commandState = 'paused';
        emitState({ remaining_ms: remainingMs });
        return { state: commandState };
      }
      if (action === 'resume') {
        if (commandState !== 'paused') throw new Error(`Command is ${commandState}; it cannot be resumed.`);
        await controlProcess(child.pid, 'resume');
        commandState = 'running';
        armTimer();
        emitState({ remaining_ms: remainingMs });
        return { state: commandState };
      }
      throw new Error(`Unknown command action: ${action}`);
    };
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', (chunk) => { stdout.append(chunk); onCommandOutput?.({ stream: 'stdout', chunk: chunk.toString() }); });
    child.stderr.on('data', (chunk) => { stderr.append(chunk); onCommandOutput?.({ stream: 'stderr', chunk: chunk.toString() }); });
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => {
      cleanup();
      commandState = 'complete';
      emitState({ exit_code: code });
      stdout.finish();
      stderr.finish();
      const ok = code === 0 && !timedOut && !aborted && !stoppedByUser;
      resolve({
        ok, executable, args, cwd: sandbox.relative(absoluteCwd), exit_code: code, signal: exitSignal,
        timed_out: timedOut, aborted, stopped: stoppedByUser, truncated: stdout.truncated || stderr.truncated, stdout: stdout.text, stderr: stderr.text,
        ...(!ok ? {
          code: aborted ? 'COMMAND_ABORTED' : stoppedByUser ? 'COMMAND_STOPPED' : timedOut ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED',
          error: aborted ? 'Command was cancelled.' : stoppedByUser ? 'Command was stopped by the user.' : timedOut ? `Command exceeded ${timeoutMs} ms.` : `Command exited with code ${code}.`,
          suggestion: 'Inspect stdout and stderr before choosing the next step; this command did not succeed.'
        } : {})
      });
    });
    armTimer();
    onCommandStart?.({ pid: child.pid, control });
    emitState();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
