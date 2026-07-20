import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_TEXT_BYTES, decodeUtf8, formatFailure, parseTarget } from "../util.js";

const SHELL_CANDIDATES = [
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/ash",
  "/usr/bin/ash",
  "/bin/sh",
  "/usr/bin/sh",
];

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ stdin?: string|Buffer, maxBytes?: number, timeoutMs?: number, cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<import('./contract.js').CapturedResult>}
 */
export function spawnCaptured(command, args, {
  stdin,
  maxBytes = MAX_TEXT_BYTES,
  timeoutMs = 30000,
  cwd,
  env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= maxBytes) stderr.push(chunk);
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (stdoutSize > maxBytes) return reject(new Error(`remote output exceeded ${maxBytes} bytes`));
      if (stderrSize > maxBytes) return reject(new Error(`remote stderr output exceeded ${maxBytes} bytes`));
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1, signal });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

/**
 * Build the docker exec argument list for a non-interactive command.
 * @param {string} container
 * @param {string} shell
 * @param {string} remoteCommand
 * @param {{ env?: Record<string,string>, workdir?: string, user?: string }} [execOpts]
 */
export function dockerExecArgs(container, shell, remoteCommand, execOpts = {}) {
  const args = ["exec"];
  if (execOpts.workdir) args.push("-w", execOpts.workdir);
  if (execOpts.user) args.push("-u", execOpts.user);
  if (execOpts.env) {
    for (const [k, v] of Object.entries(execOpts.env)) {
      args.push("-e", `${k}=${v}`);
    }
  }
  args.push(container, shell, "-c", remoteCommand);
  return args;
}

/**
 * Real transport: local `docker` binary (exec / cp).
 * @param {{ dockerBinary?: string }} [options]
 * @returns {import('./contract.js').DockerTransport & { getMuxEnabled: () => boolean }}
 */
export function createRealTransport({ dockerBinary = "docker" } = {}) {
  const shellCache = new Map();

  async function detectShell(container) {
    for (const shell of SHELL_CANDIDATES) {
      try {
        const result = await spawnCaptured(dockerBinary, ["exec", container, shell, "-c", "exit 0"], { timeoutMs: 5000, maxBytes: 1024 });
        if (result.code === 0) return shell;
      } catch {
        // try next shell
      }
    }
    return "/bin/sh";
  }

  async function resolveShell(container) {
    if (!shellCache.has(container)) {
      shellCache.set(container, await detectShell(container));
    }
    return shellCache.get(container);
  }

  function getShellSync(container) {
    return shellCache.get(container) || "/bin/sh";
  }

  async function exec(container, remoteCommand, {
    stdin,
    maxBytes = MAX_TEXT_BYTES,
    timeoutMs = 30000,
    allowNonZero = false,
    okCodes = [],
  } = {}) {
    parseTarget(container);
    const shell = await resolveShell(container);
    const args = dockerExecArgs(container, shell, remoteCommand);
    const result = await spawnCaptured(dockerBinary, args, { stdin, maxBytes, timeoutMs });
    const successCodes = new Set([0, ...okCodes]);
    if (!allowNonZero && !successCodes.has(result.code)) {
      throw new Error(formatFailure(result));
    }
    return result;
  }

  async function cp(container, { direction, localPath, remotePath, recursive = false, timeoutMs = 120000 }) {
    parseTarget(container);
    if (!localPath || !remotePath) throw new Error("local_path and remote_path are required");
    if (localPath.includes("\0") || remotePath.includes("\0")) throw new Error("paths must not contain NUL");

    const containerSpec = `${container}:${remotePath}`;

    const buildArgs = () => {
      const args = ["cp"];
      if (recursive) args.push("-r");
      if (direction === "to") {
        args.push(localPath, containerSpec);
      } else if (direction === "from") {
        args.push(containerSpec, localPath);
      } else {
        throw new Error('direction must be "to" (upload) or "from" (download)');
      }
      return args;
    };

    if (direction === "to") {
      if (!existsSync(localPath)) throw new Error(`local path does not exist: ${localPath}`);
      const st = statSync(localPath);
      if (st.isDirectory() && !recursive) throw new Error("local path is a directory; set recursive=true");
      if (!st.isDirectory() && !st.isFile()) throw new Error(`local path is not a regular file/directory: ${localPath}`);
    } else if (direction === "from") {
      mkdirSync(dirname(localPath), { recursive: true });
    } else {
      throw new Error('direction must be "to" (upload) or "from" (download)');
    }

    const result = await spawnCaptured(dockerBinary, buildArgs(), { timeoutMs, maxBytes: MAX_TEXT_BYTES });
    if (result.code !== 0) throw new Error(formatFailure(result));
    return result;
  }

  async function close() {
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0, signal: null };
  }

  function spawnInteractive(container, remoteCommand) {
    parseTarget(container);
    const shell = getShellSync(container);
    return spawn(dockerBinary, ["exec", "-it", container, shell, "-c", remoteCommand], { stdio: ["pipe", "pipe", "pipe"] });
  }

  function spawnBackground(container, remoteCommand) {
    parseTarget(container);
    const shell = getShellSync(container);
    return spawn(dockerBinary, ["exec", "-d", container, shell, "-c", remoteCommand], { stdio: "ignore", detached: true });
  }

  return {
    exec,
    cp,
    close,
    spawnInteractive,
    spawnBackground,
    getMuxEnabled: () => false,
  };
}
