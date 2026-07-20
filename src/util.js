export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const CONTROL_PERSIST_SECONDS = 600;

export const INTERACTIVE_QUIET_MS_DEFAULT = 500;
export const INTERACTIVE_MAX_WAIT_MS = 15000;
export const INTERACTIVE_SESSION_TTL_MS = 10 * 60 * 1000;
export const INTERACTIVE_MAX_SESSIONS = 8;
export const INTERACTIVE_MAX_BUFFER_BYTES = MAX_TEXT_BYTES;

/**
 * Validate that a target string is a non-empty Docker container name or id.
 * Docker container names may include letters, digits, underscores, periods,
 * and hyphens (per Docker naming rules), and ids are hex strings.
 * @param {string} value
 * @returns {string}
 */
export function parseTarget(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("container is required");
  const target = value.trim();
  if (/\s/.test(target)) throw new Error("container name must not contain spaces");
  if (target.startsWith("-") || target.startsWith("/")) throw new Error("invalid container name");
  return target;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function decodeUtf8(buffer) {
  return buffer.toString("utf8");
}

export function formatFailure(result) {
  const code = result.code ?? 1;
  const stderr = decodeUtf8(result.stderr).trim();
  const stdout = decodeUtf8(result.stdout).trim();
  const parts = [`docker exited with code ${code}`];
  if (stderr) parts.push(stderr);
  if (stdout) parts.push(stdout);
  return parts.join("\n");
}

export function textResult(text, { isError = false } = {}) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

export function errorResult(error) {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

export async function safe(fn) {
  try {
    return await fn();
  } catch (error) {
    return errorResult(error);
  }
}

export function combineStreams(stdout, stderr) {
  const out = stdout.endsWith("\n") || stdout.length === 0 ? stdout : `${stdout}\n`;
  const err = stderr.trim();
  if (!err) return out;
  if (!out) return stderr.endsWith("\n") ? stderr : `${stderr}\n`;
  return `${out}[stderr]\n${stderr.endsWith("\n") ? stderr : `${stderr}\n`}`;
}

/** Non-login shell so broken profile scripts cannot abort the command. */
export function remoteShellCommand(command) {
  return `if command -v bash >/dev/null 2>&1; then bash --noprofile --norc -c -- ${shellQuote(command)}; else sh -c -- ${shellQuote(command)}; fi`;
}

/**
 * List a remote directory with metadata in `ls -lAh` style.
 * @param {string} path
 */
export function remoteListDirCommand(path) {
  return `LC_ALL=C ls -lAh -- ${shellQuote(path)}`;
}

/**
 * Read a remote text file with optional line offset/limit.
 * @param {string} path
 * @param {number} [offset] 1-based starting line (0 is treated as 1)
 * @param {number} [limit] number of lines; 0 means unlimited
 */
export function remoteReadFileCommand(path, offset = 1, limit = 0) {
  const p = shellQuote(path);
  const start = Math.max(1, Math.floor(offset || 1));
  if (start === 1 && limit === 0) return `cat -- ${p}`;
  if (start === 1) return `set -o pipefail; cat -- ${p} | head -n ${limit}`;
  if (limit === 0) return `cat -- ${p} | tail -n +${start}`;
  return `set -o pipefail; cat -- ${p} | tail -n +${start} | head -n ${limit}`;
}

/**
 * Build a ripgrep/grep remote command string.
 * @param {object} opts
 * @param {string} opts.pattern
 * @param {string} [opts.path]
 * @param {string} [opts.glob]
 * @param {boolean} [opts.ignoreCase]
 * @param {boolean} [opts.fixedStrings]
 * @param {boolean} [opts.wordRegexp]
 * @param {boolean} [opts.invert]
 * @param {number} [opts.maxResults]
 */
export function remoteGrepCommand({
  pattern,
  path = ".",
  glob,
  ignoreCase = false,
  fixedStrings = false,
  wordRegexp = false,
  invert = false,
  maxResults,
} = {}) {
  const qPattern = shellQuote(pattern);
  const qPath = shellQuote(path);
  const rgParts = ["--no-heading -n --hidden --no-messages"];
  const grepParts = ["-RIn --exclude-dir=.git --exclude-dir=node_modules"];
  if (glob) {
    rgParts.push(`--glob ${shellQuote(glob)}`);
    grepParts.push(`--include=${shellQuote(glob)}`);
  }
  if (ignoreCase) { rgParts.push("-i"); grepParts.push("-i"); }
  if (fixedStrings) { rgParts.push("-F"); grepParts.push("-F"); }
  if (wordRegexp) { rgParts.push("-w"); grepParts.push("-w"); }
  if (invert) { rgParts.push("-v"); grepParts.push("-v"); }
  if (maxResults) {
    const n = Number(maxResults);
    rgParts.push(`-m ${n}`);
    grepParts.push(`-m ${n}`);
  }
  rgParts.push("--");
  grepParts.push("--");
  return [
    "set +e",
    "if command -v rg >/dev/null 2>&1; then",
    `  out=$(rg ${rgParts.join(" ")} ${qPattern} ${qPath} 2>/dev/null)`,
    "  ec=$?",
    "else",
    `  out=$(grep ${grepParts.join(" ")} ${qPattern} ${qPath} 2>/dev/null)`,
    "  ec=$?",
    "fi",
    "printf '%s' \"$out\"",
    "if [ \"$ec\" -eq 0 ] || [ \"$ec\" -eq 1 ]; then exit 0; fi",
    "if [ -n \"$out\" ]; then exit 0; fi",
    "exit \"$ec\"",
  ].join("\n");
}

/**
 * Build a remote patch command supporting strip level and dry-run.
 * @param {object} opts
 * @param {number} [opts.strip]
 * @param {boolean} [opts.dry_run]
 */
export function remoteApplyPatchCommand({ strip = 0, dry_run = false } = {}) {
  const p = Number(strip) || 0;
  const header = [
    "tmpfile=$(mktemp)",
    "cat > \"$tmpfile\"",
  ];
  if (dry_run) {
    return [
      ...header,
      "if command -v git >/dev/null 2>&1; then",
      `  git apply --check -p${p} \"$tmpfile\" 2>/dev/null && { rm -f \\"tmpfile\\"; exit 0; }`,
      "fi",
      "if command -v patch >/dev/null 2>&1; then",
      `  patch --dry-run -p${p} < \"$tmpfile\" 2>/dev/null && { rm -f \\"tmpfile\\"; exit 0; }`,
      "fi",
      'rm -f "$tmpfile"',
      'echo "dry-run not supported: neither git apply --check nor patch --dry-run is available" >&2; exit 2',
    ].join("\n");
  }
  const lines = [...header];
  if (p === 0) {
    lines.push(
      "if command -v apply_patch >/dev/null 2>&1; then",
      '  apply_patch < "$tmpfile" && { rm -f "$tmpfile"; exit 0; }',
      "fi",
    );
  }
  lines.push(
    "if command -v git >/dev/null 2>&1; then",
    `  git apply -p${p} "$tmpfile" 2>/dev/null && { rm -f \\"tmpfile\\"; exit 0; }`,
    "fi",
    "if command -v patch >/dev/null 2>&1; then",
    `  patch -p${p} < "$tmpfile" && { rm -f \\"tmpfile\\"; exit 0; }`,
    "fi",
    'rm -f "$tmpfile"',
    '  echo "no patch tool found" >&2; exit 2',
  );
  return lines.join("\n");
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function appendToSessionBuffer(session, chunk, maxBytes = INTERACTIVE_MAX_BUFFER_BYTES) {
  session.chunks.push(chunk);
  session.bufferedBytes += chunk.length;
  while (session.bufferedBytes > maxBytes && session.chunks.length > 1) {
    session.truncated = true;
    const dropped = session.chunks.shift();
    session.bufferedBytes -= dropped.length;
  }
}

export function drainSessionOutput(session) {
  const text = Buffer.concat(session.chunks).toString("utf8");
  session.chunks = [];
  session.bufferedBytes = 0;
  const truncated = session.truncated;
  session.truncated = false;
  return { text, truncated };
}

/** Resolve once output has gone quiet, the process exits, or maxWaitMs elapses. */
export function settleSession(session, { quietMs = INTERACTIVE_QUIET_MS_DEFAULT, maxWaitMs = INTERACTIVE_MAX_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (session.exited) return resolve();
      const now = Date.now();
      if (now - session.lastDataAt >= quietMs) return resolve();
      if (now - start >= maxWaitMs) return resolve();
      setTimeout(check, 50);
    };
    check();
  });
}
