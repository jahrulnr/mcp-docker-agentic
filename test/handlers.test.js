import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHandlers } from "../src/app.js";
import { createJobManager } from "../src/jobs.js";
import { createMockTransport, resolveRemotePath } from "../src/transport/mock.js";
import { remoteShellCommand } from "../src/util.js";

const TARGET = "my-container";

function textOf(result) {
  assert.ok(result?.content?.[0]?.type === "text");
  return result.content[0].text;
}

describe("resolveRemotePath", () => {
  it("maps absolute remote paths under the sandbox root", () => {
    assert.equal(resolveRemotePath("/tmp/root", "/etc/hostname"), resolve("/tmp/root", "etc/hostname"));
    assert.equal(resolveRemotePath("/tmp/root", "rel"), resolve("/tmp/root", "rel"));
  });

  it("rejects path escape", () => {
    assert.throws(() => resolveRemotePath("/tmp/root", "../outside"), /escapes/);
  });
});

describe("createMockTransport", () => {
  /** @type {ReturnType<typeof createMockTransport>} */
  let transport;

  before(() => {
    transport = createMockTransport({ identity: { uid: "42", hostname: "unit-mock" } });
  });

  after(() => {
    transport.dispose();
  });

  it("exec runs the same remoteShellCommand string and returns stdout", async () => {
    const result = await transport.exec(TARGET, remoteShellCommand("printf 'ok\\n'"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "ok\n");
  });

  it("exec rejects non-zero unless allowNonZero", async () => {
    await assert.rejects(
      () => transport.exec(TARGET, remoteShellCommand("exit 7")),
      /code 7/,
    );
    const result = await transport.exec(TARGET, remoteShellCommand("exit 7"), { allowNonZero: true });
    assert.equal(result.code, 7);
  });

  it("cp to/from round-trips file contents", async () => {
    const localDir = mkdtempSync(join(tmpdir(), "mcp-docker-local-"));
    try {
      const localFile = join(localDir, "payload.txt");
      writeFileSync(localFile, "hello-cp\n");
      await transport.cp(TARGET, {
        direction: "to",
        localPath: localFile,
        remotePath: "uploads/payload.txt",
      });
      const remoteAbs = transport.resolvePath("uploads/payload.txt");
      assert.equal(readFileSync(remoteAbs, "utf8"), "hello-cp\n");

      const downloaded = join(localDir, "back.txt");
      await transport.cp(TARGET, {
        direction: "from",
        localPath: downloaded,
        remotePath: "uploads/payload.txt",
      });
      assert.equal(readFileSync(downloaded, "utf8"), "hello-cp\n");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  it("close succeeds", async () => {
    const result = await transport.close(TARGET);
    assert.equal(result.code, 0);
  });
});

describe("handlers via mock transport (Docker contract)", () => {
  /** @type {ReturnType<typeof createMockTransport>} */
  let transport;
  /** @type {ReturnType<typeof createHandlers>} */
  let api;
  let localDir;
  let jobManager;

  before(() => {
    transport = createMockTransport({ identity: { uid: "1000", hostname: "mock-container" } });
    localDir = mkdtempSync(join(tmpdir(), "mcp-docker-handler-"));
    jobManager = createJobManager({ jobDir: join(localDir, "jobs") });
    api = createHandlers(transport, { jobManager });
  });

  after(() => {
    api.killAllInteractiveSessions();
    api.jobManager.killAll("SIGTERM");
    transport.dispose();
    rmSync(localDir, { recursive: true, force: true });
  });

  it("docker_ping returns uid and hostname", async () => {
    const result = await api.handlers.docker_ping({ container: TARGET });
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "1000\nmock-container");
  });

  it("docker_write_file + docker_read_file round-trip", async () => {
    const path = "app/config.env";
    const write = await api.handlers.docker_write_file({
      container: TARGET,
      path,
      content: "PORT=3000\n",
      append: false,
      create_dirs: true,
    });
    assert.equal(write.isError, undefined);
    assert.match(textOf(write), /Wrote/);

    const read = await api.handlers.docker_read_file({ container: TARGET, path });
    assert.equal(textOf(read), "PORT=3000\n");
  });

  it("docker_read_file supports offset and limit", async () => {
    const path = "app/lines.txt";
    await api.handlers.docker_write_file({
      container: TARGET,
      path,
      content: "line1\nline2\nline3\nline4\nline5\n",
      append: false,
      create_dirs: true,
    });
    const partial = await api.handlers.docker_read_file({ container: TARGET, path, offset: 2, limit: 2 });
    assert.equal(textOf(partial), "line2\nline3\n");

    const full = await api.handlers.docker_read_file({ container: TARGET, path, limit: 0 });
    assert.equal(full.isError, undefined);
    assert.equal(textOf(full), "line1\nline2\nline3\nline4\nline5\n");
  });

  it("docker_write_file appends when append=true", async () => {
    const path = "app/append.log";
    await api.handlers.docker_write_file({ container: TARGET, path, content: "a\n", append: false, create_dirs: true });
    await api.handlers.docker_write_file({ container: TARGET, path, content: "b\n", append: true, create_dirs: true });
    const read = await api.handlers.docker_read_file({ container: TARGET, path });
    assert.equal(textOf(read), "a\nb\n");
  });

  it("docker_mkdir creates nested directories", async () => {
    const path = "releases/42/bin";
    const result = await api.handlers.docker_mkdir({ container: TARGET, path });
    assert.match(textOf(result), /Created directory/);
    const { statSync } = await import("node:fs");
    assert.ok(statSync(transport.resolvePath(path)).isDirectory());
  });

  it("docker_exec returns exit_code and stdout; non-zero sets isError", async () => {
    const ok = await api.handlers.docker_exec({ container: TARGET, command: "printf 'MCP_OK\\n'", timeout_ms: 5000 });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /^exit_code=0\nMCP_OK\n/);

    const bad = await api.handlers.docker_exec({ container: TARGET, command: "echo fail >&2; exit 3", timeout_ms: 5000 });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /exit_code=3/);
    assert.match(textOf(bad), /fail/);
  });

  it("docker_exec supports stdin, cwd, env, and ok_codes", async () => {
    await api.handlers.docker_mkdir({ container: TARGET, path: "releases/42" });

    const stdin = await api.handlers.docker_exec({ container: TARGET, command: "cat", stdin: "hello\n" });
    assert.equal(stdin.isError, undefined);
    assert.match(textOf(stdin), /exit_code=0/);
    assert.match(textOf(stdin), /hello/);

    const cwd = await api.handlers.docker_exec({ container: TARGET, command: "pwd", cwd: "releases/42" });
    assert.equal(cwd.isError, undefined);
    assert.match(textOf(cwd), /releases\/42/);

    const env = await api.handlers.docker_exec({ container: TARGET, command: "printf '%s\\n' \"$FOO\"", env: { FOO: "bar" } });
    assert.equal(env.isError, undefined);
    assert.match(textOf(env), /bar/);

    const ok = await api.handlers.docker_exec({ container: TARGET, command: "exit 7", ok_codes: [7] });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /exit_code=7/);
  });

  it("docker_list_dir lists created files with ls -lAh metadata", async () => {
    await api.handlers.docker_write_file({ container: TARGET, path: "listed/a.txt", content: "x", append: false, create_dirs: true });
    const result = await api.handlers.docker_list_dir({ container: TARGET, path: "listed" });
    const text = textOf(result);
    assert.match(text, /a\.txt/);
    assert.match(text, /total/);
    assert.match(text, /[-d][r-][w-][x-]/);
  });

  it("docker_grep finds matches and reports no matches cleanly", async () => {
    await api.handlers.docker_write_file({
      container: TARGET,
      path: "src/todo.js",
      content: "// TODO: fix\nconst x = 1;\n",
      append: false,
      create_dirs: true,
    });
    const hit = await api.handlers.docker_grep({ container: TARGET, pattern: "TODO", path: "src" });
    assert.equal(hit.isError, undefined);
    assert.match(textOf(hit), /TODO/);

    const miss = await api.handlers.docker_grep({ container: TARGET, pattern: "NO_SUCH_TOKEN_XYZ", path: "src" });
    assert.equal(miss.isError, undefined);
    assert.match(textOf(miss), /no matches/);
  });

  it("docker_delete removes a file", async () => {
    const path = "tmp/deleteme.txt";
    await api.handlers.docker_write_file({ container: TARGET, path, content: "bye", append: false, create_dirs: true });
    const del = await api.handlers.docker_delete({ container: TARGET, path, recursive: false });
    assert.match(textOf(del), /Deleted/);
    const read = await api.handlers.docker_read_file({ container: TARGET, path });
    assert.equal(read.isError, true);
  });

  it("docker_cp_to / docker_cp_from via handlers", async () => {
    const localFile = join(localDir, "up.txt");
    writeFileSync(localFile, "via-handler\n");
    const up = await api.handlers.docker_cp_to({
      container: TARGET,
      local_path: localFile,
      remote_path: "cp/up.txt",
      recursive: false,
      timeout_ms: 5000,
    });
    assert.match(textOf(up), /Copied/);

    const down = join(localDir, "down.txt");
    const got = await api.handlers.docker_cp_from({
      container: TARGET,
      remote_path: "cp/up.txt",
      local_path: down,
      recursive: false,
      timeout_ms: 5000,
    });
    assert.match(textOf(got), /Copied/);
    assert.equal(readFileSync(down, "utf8"), "via-handler\n");
  });

  it("docker_close reports no persistent connection", async () => {
    const result = await api.handlers.docker_close({});
    assert.match(textOf(result), /persistent/);
  });

  it("docker_interactive_exec + input for a prompting script", async () => {
    const script = [
      "printf 'Password: '",
      "IFS= read -r line",
      "printf 'got=%s\\n' \"$line\"",
    ].join("; ");

    const started = await api.handlers.docker_interactive_exec({
      container: TARGET,
      command: script,
      quiet_ms: 200,
    });
    assert.equal(started.isError, undefined);
    const startText = textOf(started);
    assert.match(startText, /session_id=/);
    assert.match(startText, /Password:/);
    const sessionId = startText.match(/session_id=([^\n]+)/)[1];

    const replied = await api.handlers.docker_interactive_input({
      session_id: sessionId,
      input: "secret",
      newline: true,
      quiet_ms: 200,
    });
    assert.match(textOf(replied), /got=secret/);
    assert.match(textOf(replied), /exited \(code 0\)/);

    const list = await api.handlers.docker_interactive_list({});
    assert.match(textOf(list), /no active interactive sessions/);
  });

  it("docker_interactive_close removes a running session", async () => {
    const started = await api.handlers.docker_interactive_exec({
      container: TARGET,
      command: "printf 'ready\\n'; sleep 5",
      quiet_ms: 150,
    });
    const sessionId = textOf(started).match(/session_id=([^\n]+)/)[1];
    const closed = await api.handlers.docker_interactive_close({ session_id: sessionId });
    assert.match(textOf(closed), /Closed interactive session/);
    const list = await api.handlers.docker_interactive_list({});
    assert.match(textOf(list), /no active/);
  });

  it("docker_read_image returns MCP image content", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const path = "img/pixel.png";
    mkdirSync(transport.resolvePath("img"), { recursive: true });
    writeFileSync(transport.resolvePath(path), png);

    const result = await api.handlers.docker_read_image({ container: TARGET, path });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/png");
    assert.equal(Buffer.from(result.content[0].data, "base64").equals(png), true);
  });

  it("invalid container surfaces as isError without throwing", async () => {
    const result = await api.handlers.docker_ping({ container: "not a container" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /container/);
  });

  it("docker_exec background starts a detached job and returns a job_id", async () => {
    const started = await api.handlers.docker_exec({
      container: TARGET,
      command: "sleep 0.2; echo 'job done'",
      background: true,
    });
    assert.equal(started.isError, undefined);
    const text = textOf(started);
    assert.match(text, /job_id=/);
    assert.match(text, /status=started/);

    const jobId = text.match(/job_id=([^\n]+)/)[1];
    const result = await api.handlers.docker_exec_result({
      job_id: jobId,
      wait: true,
      timeout_ms: 5000,
    });
    assert.equal(result.isError, undefined);
    const resultText = textOf(result);
    assert.match(resultText, /status=exited/);
    assert.match(resultText, /job done/);
    assert.match(resultText, /exit_code=0/);
  });

  it("docker_exec background rejects stdin", async () => {
    const result = await api.handlers.docker_exec({
      container: TARGET,
      command: "cat",
      background: true,
      stdin: "x\n",
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /stdin.*background/);
  });

  it("docker_exec_kill stops a background job and can clean up", async () => {
    const started = await api.handlers.docker_exec({
      container: TARGET,
      command: "sleep 60",
      background: true,
    });
    const jobId = textOf(started).match(/job_id=([^\n]+)/)[1];

    const killed = await api.handlers.docker_exec_kill({ job_id: jobId, signal: "SIGTERM" });
    assert.equal(killed.isError, undefined);
    assert.match(textOf(killed), /killed=true/);

    const result = await api.handlers.docker_exec_result({ job_id: jobId, wait: true, timeout_ms: 2000 });
    assert.match(textOf(result), /status=exited/);

    const cleaned = await api.handlers.docker_exec_kill({ job_id: jobId, cleanup: true });
    assert.match(textOf(cleaned), /cleaned=true/);
  });
});
