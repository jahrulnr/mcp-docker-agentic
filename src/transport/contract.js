/**
 * Docker transport contract — real and mock backends must implement this shape.
 *
 * Design goal: tool handlers call only this contract, never `spawn("docker")` directly.
 * Unit tests inject `createMockTransport()` so behavior matches production without a real container.
 *
 * @typedef {object} CapturedResult
 * @property {Buffer} stdout
 * @property {Buffer} stderr
 * @property {number} code
 * @property {string|null} [signal]
 *
 * @typedef {object} ExecOptions
 * @property {string|Buffer} [stdin]
 * @property {number} [maxBytes]
 * @property {number} [timeoutMs]
 * @property {boolean} [allowNonZero]
 * @property {number[]} [okCodes]
 *
 * @typedef {object} CpOptions
 * @property {"to"|"from"} direction
 * @property {string} localPath
 * @property {string} remotePath
 * @property {boolean} [recursive]
 * @property {number} [timeoutMs]
 *
 * @typedef {object} DockerTransport
 * @property {(target: string, remoteCommand: string, opts?: ExecOptions) => Promise<CapturedResult>} exec
 *   Run a remote command string inside the container.
 * @property {(target: string, opts: CpOptions) => Promise<CapturedResult>} cp
 * @property {(target: string) => Promise<CapturedResult>} close
 *   No-op for Docker (no persistent connection).
 * @property {(target: string, remoteCommand: string) => import('node:child_process').ChildProcess | Promise<import('node:child_process').ChildProcess>} spawnInteractive
 *   Spawn an interactive session with stdin/stdout/stderr pipes (no fake TTY).
 * @property {(target: string, remoteCommand: string) => import('node:child_process').ChildProcess | Promise<import('node:child_process').ChildProcess>} spawnBackground
 *   Spawn a background session with stdout/stderr pipes (stdin ignored). Must not detach from the docker client (`-d`).
 * @property {() => boolean} [getMuxEnabled]
 *   Always false for Docker (no multiplexing).
 * @property {() => void} [dispose]
 *   Optional cleanup (mock temp dirs, timers, open children).
 */

export {};
