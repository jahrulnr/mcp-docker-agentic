import { dirname as posixDirname } from "node:path/posix";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createJobManager } from "./jobs.js";
import {
  INTERACTIVE_MAX_SESSIONS,
  INTERACTIVE_QUIET_MS_DEFAULT,
  INTERACTIVE_SESSION_TTL_MS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  appendToSessionBuffer,
  combineStreams,
  decodeUtf8,
  drainSessionOutput,
  formatBytes,
  formatFailure,
  parseTarget,
  remoteApplyPatchCommand,
  remoteGrepCommand,
  remoteListDirCommand,
  remoteReadFileCommand,
  remoteShellCommand,
  safe,
  settleSession,
  shellQuote,
  textResult,
} from "./util.js";

const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

/**
 * @param {import('./transport/contract.js').DockerTransport} transport
 * @param {{ interactiveSessions?: Map<string, object>, jobManager?: import('./jobs.js').JobManager, now?: () => number, randomId?: () => string }} [opts]
 */
export function createHandlers(transport, {
  interactiveSessions = new Map(),
  jobManager = createJobManager(),
  now = () => Date.now(),
  randomId = () => randomUUID(),
} = {}) {
  function killSessionChild(session) {
    const child = session.child;
    if (!child || child.killed) return;
    try {
      if (SUPPORTS_PROCESS_GROUPS && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }

  function pruneStaleSessions() {
    const t = now();
    for (const [id, session] of interactiveSessions) {
      if (session.exited || t - session.lastActivity > INTERACTIVE_SESSION_TTL_MS) {
        if (!session.exited) killSessionChild(session);
        interactiveSessions.delete(id);
      }
    }
  }

  function killAllInteractiveSessions() {
    for (const session of interactiveSessions.values()) {
      killSessionChild(session);
    }
    interactiveSessions.clear();
  }

  const handlers = {
    docker_ping: async ({ container }) => safe(async () => {
      const result = await transport.exec(container, remoteShellCommand("id -u && hostname"), { timeoutMs: 15000 });
      return textResult(decodeUtf8(result.stdout).trim());
    }),

    docker_read_file: async ({ container, path, offset = 1, limit = 200 }) => safe(async () => {
      const result = await transport.exec(container, remoteShellCommand(remoteReadFileCommand(path, offset, limit)));
      return textResult(decodeUtf8(result.stdout));
    }),

    docker_write_file: async ({ container, path, content, append = false, create_dirs = true }) => safe(async () => {
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error(`content exceeds ${MAX_TEXT_BYTES} bytes`);
      const mkdirCmd = create_dirs ? `mkdir -p -- ${shellQuote(posixDirname(path))} && ` : "";
      const redirect = append ? ">>" : ">";
      const command = `${mkdirCmd}cat ${redirect} ${shellQuote(path)}`;
      await transport.exec(container, remoteShellCommand(command), { stdin: content, maxBytes: MAX_TEXT_BYTES });
      return textResult(`${append ? "Appended to" : "Wrote"} ${container}:${path} (${Buffer.byteLength(content, "utf8")} bytes)`);
    }),

    docker_mkdir: async ({ container, path }) => safe(async () => {
      await transport.exec(container, remoteShellCommand(`mkdir -p -- ${shellQuote(path)}`));
      return textResult(`Created directory ${container}:${path}`);
    }),

    docker_read_image: async ({ container, path }) => safe(async () => {
      const result = await transport.exec(container, remoteShellCommand(`base64 < ${shellQuote(path)}`), { maxBytes: MAX_IMAGE_BYTES * 2 });
      const ext = path.toLowerCase().split(".").pop();
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" })[ext] || "application/octet-stream";
      const data = Buffer.from(decodeUtf8(result.stdout).replace(/\s+/g, ""), "base64");
      if (data.length > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
      return { content: [{ type: "image", data: data.toString("base64"), mimeType: mime }, { type: "text", text: `${path} (${mime}, ${data.length} bytes)` }] };
    }),

    docker_list_dir: async ({ container, path = "." }) => safe(async () => {
      const result = await transport.exec(container, remoteShellCommand(remoteListDirCommand(path)));
      return textResult(decodeUtf8(result.stdout));
    }),

    docker_grep: async ({ container, pattern, path = ".", glob, ignore_case = false, fixed_strings = false, word_regexp = false, invert = false, max_results }) => safe(async () => {
      const remote = remoteGrepCommand({
        pattern,
        path,
        glob,
        ignoreCase: ignore_case,
        fixedStrings: fixed_strings,
        wordRegexp: word_regexp,
        invert,
        maxResults: max_results,
      });
      const result = await transport.exec(container, remoteShellCommand(remote), { maxBytes: MAX_TEXT_BYTES, allowNonZero: true });
      const stdout = decodeUtf8(result.stdout);
      const stderr = decodeUtf8(result.stderr).trim();
      if (result.code === 0) {
        return textResult(stdout || "(no matches)\n");
      }
      if (stdout.trim()) {
        return textResult(combineStreams(stdout, stderr));
      }
      throw new Error(formatFailure(result));
    }),

    docker_apply_patch: async ({ container, patch, strip = 0, dry_run = false }) => safe(async () => {
      const result = await transport.exec(container, remoteShellCommand(remoteApplyPatchCommand({ strip, dry_run })), { stdin: patch, maxBytes: MAX_TEXT_BYTES });
      return textResult(decodeUtf8(result.stdout) || (dry_run ? "Patch dry-run succeeded." : "Patch applied successfully."));
    }),

    docker_delete: async ({ container, path, recursive = false }) => safe(async () => {
      const command = recursive ? `rm -rf -- ${shellQuote(path)}` : `rm -f -- ${shellQuote(path)}`;
      await transport.exec(container, remoteShellCommand(command));
      return textResult(`Deleted ${path}${recursive ? " recursively" : ""}.`);
    }),

    docker_exec: async ({ container, command, timeout_ms = 30000, stdin, max_output_bytes = MAX_TEXT_BYTES, ok_codes = [], cwd, env, background = false }) => safe(async () => {
      if (background && stdin !== undefined) {
        throw new Error("stdin is not supported for background jobs");
      }
      let inner = command;
      if (cwd) inner = `cd -- ${shellQuote(cwd)} && ${inner}`;
      if (env) {
        const exports = Object.entries(env)
          .map(([k, v]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment variable name: ${k}`);
            return `export ${k}=${shellQuote(v)}`;
          })
          .join("; ");
        if (exports) inner = `${exports}; ${inner}`;
      }
      const remoteCommand = remoteShellCommand(inner);
      if (background) {
        const child = transport.spawnBackground(container, remoteCommand);
        const job = await jobManager.start({ target: container, command, cwd, env, child });
        return textResult(`job_id=${job.id}\nstatus=started\ncommand=${command}`);
      }
      const result = await transport.exec(container, remoteCommand, {
        stdin,
        maxBytes: max_output_bytes,
        timeoutMs: timeout_ms,
        allowNonZero: true,
      });
      const stdout = decodeUtf8(result.stdout);
      const stderr = decodeUtf8(result.stderr);
      const code = result.code ?? 1;
      const okSet = new Set([0, ...ok_codes]);
      const body = combineStreams(stdout, stderr);
      return textResult(`exit_code=${code}\n${body}`, { isError: !okSet.has(code) });
    }),

    docker_exec_result: async ({ job_id, wait = false, timeout_ms = 10000 }) => safe(async () => {
      const res = await jobManager.getResult(job_id, { wait, timeoutMs: timeout_ms });
      if (!res) throw new Error(`no background job with id ${job_id}`);
      const parts = [`job_id=${res.id || job_id}`, `status=${res.status}`];
      if (res.status === "exited" || res.status === "error" || res.exitCode !== undefined) {
        parts.push(`exit_code=${res.exitCode ?? ""}`);
      }
      if (res.signal) parts.push(`signal=${res.signal}`);
      if (res.error) parts.push(`error=${res.error}`);
      if (res.timedOut) parts.push("timed_out=true");
      parts.push(`stdout:\n${res.stdout || ""}`);
      parts.push(`stderr:\n${res.stderr || ""}`);
      return textResult(parts.join("\n"));
    }),

    docker_exec_kill: async ({ job_id, signal = "SIGTERM", cleanup = false }) => safe(async () => {
      const r = await jobManager.kill(job_id, signal, cleanup);
      if (!r.found) throw new Error(`no background job with id ${job_id}`);
      return textResult(`job_id=${job_id}\nfound=true\nkilled=${r.killed}\ncleaned=${r.cleaned}`);
    }),

    docker_interactive_exec: async ({ container, command, quiet_ms = INTERACTIVE_QUIET_MS_DEFAULT }) => safe(async () => {
      pruneStaleSessions();
      if (interactiveSessions.size >= INTERACTIVE_MAX_SESSIONS) {
        throw new Error(`too many open interactive sessions (max ${INTERACTIVE_MAX_SESSIONS}); close one with docker_interactive_close first`);
      }
      const child = transport.spawnInteractive(container, remoteShellCommand(command));
      const id = randomId();
      const session = {
        id, child, container, command,
        chunks: [], bufferedBytes: 0, truncated: false,
        exited: false, exitCode: null,
        lastDataAt: now(), lastActivity: now(),
      };
      child.stdout.on("data", (chunk) => { appendToSessionBuffer(session, chunk); session.lastDataAt = now(); });
      child.stderr?.on("data", (chunk) => { appendToSessionBuffer(session, chunk); session.lastDataAt = now(); });
      child.on("exit", (code, signal) => { session.exited = true; session.exitCode = code ?? (signal ? 1 : 0); });
      child.on("error", (error) => { session.exited = true; session.exitCode = 1; session.error = error.message; });
      interactiveSessions.set(id, session);

      session.lastDataAt = now();
      await settleSession(session, { quietMs: quiet_ms });
      const { text, truncated } = drainSessionOutput(session);
      session.lastActivity = now();
      const stillOpen = !session.exited;
      if (!stillOpen) interactiveSessions.delete(id);
      const status = stillOpen ? "running (send input with docker_interactive_input, or poll by omitting input)" : `exited (code ${session.exitCode})`;
      const header = stillOpen ? `session_id=${id}\nstatus=${status}` : `status=${status}`;
      return textResult(`${header}\n${truncated ? "[output truncated to fit buffer]\n" : ""}${text}`);
    }),

    docker_interactive_input: async ({ session_id, input, newline = true, quiet_ms = INTERACTIVE_QUIET_MS_DEFAULT }) => safe(async () => {
      const session = interactiveSessions.get(session_id);
      if (!session) throw new Error(`no active interactive session with id ${session_id} (it may have already exited or expired)`);
      if (input !== undefined) session.child.stdin.write(input + (newline ? "\n" : ""));
      session.lastActivity = now();
      session.lastDataAt = now();

      await settleSession(session, { quietMs: quiet_ms });
      const { text, truncated } = drainSessionOutput(session);
      const stillOpen = !session.exited;
      const status = stillOpen ? "running" : `exited (code ${session.exitCode})`;
      if (!stillOpen) interactiveSessions.delete(session_id);
      return textResult(`status=${status}\n${truncated ? "[output truncated to fit buffer]\n" : ""}${text}`);
    }),

    docker_interactive_close: async ({ session_id }) => safe(async () => {
      const session = interactiveSessions.get(session_id);
      if (!session) return textResult(`no active session ${session_id} (already closed or expired)`);
      killSessionChild(session);
      interactiveSessions.delete(session_id);
      return textResult(`Closed interactive session ${session_id}`);
    }),

    docker_interactive_list: async () => safe(async () => {
      pruneStaleSessions();
      if (interactiveSessions.size === 0) return textResult("(no active interactive sessions)");
      const lines = [...interactiveSessions.values()].map((s) =>
        `${s.id}  ${s.container}  idle=${Math.round((now() - s.lastActivity) / 1000)}s  cmd=${s.command}`);
      return textResult(lines.join("\n"));
    }),

    docker_cp_to: async ({ container, local_path, remote_path, recursive = false, timeout_ms = 120000 }) => safe(async () => {
      const st = statSync(local_path);
      await transport.cp(container, {
        direction: "to",
        localPath: local_path,
        remotePath: remote_path,
        recursive,
        timeoutMs: timeout_ms,
      });
      const size = st.isFile() ? formatBytes(st.size) : "directory";
      return textResult(`Copied ${local_path} → ${container}:${remote_path} (${size}${recursive ? ", recursive" : ""})`);
    }),

    docker_cp_from: async ({ container, remote_path, local_path, recursive = false, timeout_ms = 120000 }) => safe(async () => {
      await transport.cp(container, {
        direction: "from",
        localPath: local_path,
        remotePath: remote_path,
        recursive,
        timeoutMs: timeout_ms,
      });
      let detail = "";
      if (existsSync(local_path)) {
        const st = statSync(local_path);
        detail = st.isFile() ? ` (${formatBytes(st.size)})` : " (directory)";
      }
      return textResult(`Copied ${container}:${remote_path} → ${local_path}${detail}${recursive ? " recursive" : ""}`);
    }),

    docker_close: async () => safe(async () => {
      return textResult("Docker transport does not keep a persistent connection; there is nothing to close.");
    }),
  };

  return { handlers, interactiveSessions, pruneStaleSessions, killAllInteractiveSessions, jobManager };
}

/**
 * Build an MCP server with the given transport (real or mock).
 * @param {import('./transport/contract.js').DockerTransport} transport
 * @param {{ version?: string, jobManager?: import('./jobs.js').JobManager }} [meta]
 */
export function createApp(transport, { version = "0.1.0", jobManager } = {}) {
  const { handlers, interactiveSessions, pruneStaleSessions, killAllInteractiveSessions, jobManager: createdJobManager } = createHandlers(transport, { jobManager });
  const finalJobManager = jobManager || createdJobManager;

  const container = z.string().min(1).describe("Docker container name or id.");
  const path = z.string().min(1).describe("Absolute or relative path inside the container.");
  const localPath = z.string().min(1).describe("Absolute or relative path on the local machine.");

  const server = new McpServer({
    name: "mcp-docker-agentic",
    version,
  }, {
    instructions: [
      "Container operations use the local docker binary via `docker exec` and `docker cp`.",
      "Do not assume a command succeeded unless its tool result says so.",
      "All container commands run inside a non-login, non-interactive shell (bash --noprofile --norc, or sh) so broken profile scripts cannot corrupt output.",
      "docker_exec reports exit_code and may include [stderr]; non-zero exits set isError but still return stdout. Set background=true to run a command detached and get a job_id; use docker_exec_result to poll/wait and docker_exec_kill to stop or clean it up.",
      "docker_write_file writes text content directly to a container file (no local temp file needed); docker_mkdir creates container directories.",
      "For commands that may prompt for input (sudo password, y/N confirmations, wizards, REPLs), use docker_interactive_exec (allocates a TTY) followed by docker_interactive_input to reply or poll; close sessions with docker_interactive_close when done.",
      "docker_cp_to copies local→container; docker_cp_from copies container→local.",
      "docker_close is a no-op because Docker does not keep a persistent connection per tool call.",
    ].join(" "),
  });

  server.tool("docker_ping", "Test that a Docker container is reachable and return its identity.", { container }, handlers.docker_ping);
  server.tool("docker_read_file", "Read a UTF-8 text file from a Docker container. offset and limit select a 1-based line range; limit=0 means unlimited. Defaults to first 200 lines.", {
    container,
    path,
    offset: z.number().int().min(0).default(1).describe("1-based starting line (0 is treated as 1)."),
    limit: z.number().int().min(0).default(200).describe("Maximum number of lines to return; 0 means unlimited."),
  }, handlers.docker_read_file);
  server.tool("docker_write_file", "Write UTF-8 text content directly to a file inside a Docker container (creates or overwrites; use append=true to append instead).", {
    container, path,
    content: z.string().describe("Text content to write to the container file."),
    append: z.boolean().default(false).describe("Append to the file instead of overwriting it."),
    create_dirs: z.boolean().default(true).describe("Create the parent directory in the container if it does not exist."),
  }, handlers.docker_write_file);
  server.tool("docker_mkdir", "Create a directory (and parents) inside a Docker container, equivalent to mkdir -p.", { container, path }, handlers.docker_mkdir);
  server.tool("docker_read_image", "Read a file from a Docker container and return it as an MCP image. Supports common raster formats.", { container, path }, handlers.docker_read_image);
  server.tool("docker_list_dir", "List a directory inside a Docker container with file metadata in ls -lAh style.", { container, path: path.default(".") }, handlers.docker_list_dir);
  server.tool("docker_grep", "Search text files recursively inside a Docker container with ripgrep, falling back to grep. Output format is file:line:match.", {
    container,
    pattern: z.string().min(1),
    path: path.default("."),
    glob: z.string().optional().describe("File glob to restrict search (e.g. '*.js')."),
    ignore_case: z.boolean().default(false).describe("Case-insensitive matching (-i)."),
    fixed_strings: z.boolean().default(false).describe("Treat pattern as a literal string (-F)."),
    word_regexp: z.boolean().default(false).describe("Match whole words only (-w)."),
    invert: z.boolean().default(false).describe("Invert match, returning lines that do NOT match (-v)."),
    max_results: z.number().int().min(1).optional().describe("Stop reading each file after this many matches (-m)."),
  }, handlers.docker_grep);
  server.tool("docker_apply_patch", "Apply a unified diff inside a Docker container. Tries apply_patch (strip=0 only), then git apply, then patch. Supports dry-run and strip level.", {
    container,
    patch: z.string().min(1).describe("Unified diff to apply."),
    strip: z.number().int().min(0).default(0).describe("Number of leading path components to strip (-p<N>)."),
    dry_run: z.boolean().default(false).describe("Simulate the patch application without changing files."),
  }, handlers.docker_apply_patch);
  server.tool("docker_delete", "Delete a file or directory inside a Docker container. Directories require recursive=true.", { container, path, recursive: z.boolean().default(false) }, handlers.docker_delete);
  server.tool("docker_exec", "Execute an intentional shell command inside a Docker container. Supports stdin, cwd, env, custom output limit, and acceptable exit codes. Set background=true to run a command detached and get a job_id; stdin is not allowed for background jobs. Use docker_exec_result to poll/wait and docker_exec_kill to stop or clean up.", {
    container,
    command: z.string().min(1),
    timeout_ms: z.number().int().min(1000).max(300000).default(30000).describe("Timeout for non-background executions."),
    stdin: z.string().optional().describe("Text to write to the command's stdin. Not allowed when background=true."),
    max_output_bytes: z.number().int().min(1).max(50 * 1024 * 1024).default(MAX_TEXT_BYTES).describe("Maximum stdout/stderr bytes to capture for non-background executions."),
    ok_codes: z.array(z.number().int()).default([]).describe("Exit codes to treat as success in addition to 0."),
    cwd: z.string().min(1).optional().describe("Working directory inside the container."),
    env: z.record(z.string()).optional().describe("Extra environment variables for the command."),
    background: z.boolean().default(false).describe("Run the command detached and return a job_id instead of waiting for completion."),
  }, handlers.docker_exec);
  server.tool("docker_exec_result", "Check the status and output of a background job started with docker_exec background=true. Optionally wait until it exits.", {
    job_id: z.string().min(1).describe("The job_id returned by docker_exec background=true."),
    wait: z.boolean().default(false).describe("Block until the job exits or the timeout is reached."),
    timeout_ms: z.number().int().min(1000).max(300000).default(10000).describe("Maximum time to wait when wait=true."),
  }, handlers.docker_exec_result);
  server.tool("docker_exec_kill", "Send a signal to a background job started with docker_exec background=true. Optionally remove the job log directory.", {
    job_id: z.string().min(1).describe("The job_id returned by docker_exec background=true."),
    signal: z.string().default("SIGTERM").describe("Signal name or number to send to the process group (e.g. SIGTERM, SIGKILL)."),
    cleanup: z.boolean().default(false).describe("Remove the job log directory after signaling."),
  }, handlers.docker_exec_kill);
  server.tool("docker_interactive_exec", "Start a command inside a Docker container with a TTY allocated, for programs that prompt for input (sudo password, y/N confirmations, setup wizards, REPLs). Waits until output goes quiet (likely waiting for input) or the process exits, then returns the output so far plus a session_id. If the command finishes without prompting, the session is closed automatically and there is nothing further to do. Otherwise, use docker_interactive_input to reply or poll, and docker_interactive_close when finished. Idle sessions auto-expire after 10 minutes.", {
    container,
    command: z.string().min(1),
    quiet_ms: z.number().int().min(100).max(5000).default(INTERACTIVE_QUIET_MS_DEFAULT).describe("How long output must be idle before returning."),
  }, handlers.docker_interactive_exec);
  server.tool("docker_interactive_input", "Send a line of input to a running docker_interactive_exec session (e.g. answer a sudo password or y/N prompt), or just poll for more output if input is omitted. Returns newly produced output and status.", {
    session_id: z.string().min(1),
    input: z.string().optional().describe("Text to send. Omit to wait/poll for more output without sending anything."),
    newline: z.boolean().default(true).describe("Append a trailing newline after input (usually required for the remote program to see it as a submitted line)."),
    quiet_ms: z.number().int().min(100).max(5000).default(INTERACTIVE_QUIET_MS_DEFAULT),
  }, handlers.docker_interactive_input);
  server.tool("docker_interactive_close", "Kill and remove an interactive Docker session started with docker_interactive_exec.", { session_id: z.string().min(1) }, handlers.docker_interactive_close);
  server.tool("docker_interactive_list", "List currently open interactive Docker sessions.", {}, handlers.docker_interactive_list);
  server.tool("docker_cp_to", "Copy a local file or directory into a Docker container (analogous to docker cp local container:path).", {
    container,
    local_path: localPath,
    remote_path: path,
    recursive: z.boolean().default(false).describe("Required when local_path is a directory."),
    timeout_ms: z.number().int().min(1000).max(600000).default(120000),
  }, handlers.docker_cp_to);
  server.tool("docker_cp_from", "Copy a file or directory from a Docker container to the local machine (analogous to docker cp container:path local).", {
    container,
    remote_path: path,
    local_path: localPath,
    recursive: z.boolean().default(false).describe("Required when remote_path is a directory."),
    timeout_ms: z.number().int().min(1000).max(600000).default(120000),
  }, handlers.docker_cp_from);
  server.tool("docker_close", "No-op for Docker: the transport does not keep a persistent connection. Always succeeds.", {}, handlers.docker_close);

  const pruneTimer = setInterval(() => {
    pruneStaleSessions();
    finalJobManager.cleanupOldJobs();
  }, 60000);
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();

  function dispose() {
    clearInterval(pruneTimer);
    killAllInteractiveSessions();
    finalJobManager.killAll("SIGTERM");
    if (typeof transport.dispose === "function") transport.dispose();
  }

  return { server, handlers, interactiveSessions, dispose, pruneStaleSessions, killAllInteractiveSessions, jobManager: finalJobManager };
}
