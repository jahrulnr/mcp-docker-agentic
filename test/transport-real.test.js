import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dockerBackgroundArgs, dockerExecArgs, dockerInteractiveArgs, spawnCaptured } from "../src/transport/real.js";

describe("spawnCaptured", () => {
  it("captures small stdout and stderr", async () => {
    const result = await spawnCaptured("node", [
      "-e",
      "process.stdout.write('out\\n'); process.stderr.write('err\\n');",
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "out\n");
    assert.equal(result.stderr.toString(), "err\n");
  });

  it("forwards stdin into the child process", async () => {
    const result = await spawnCaptured("node", [
      "-e",
      "let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write(s));",
    ], { stdin: "hello-stdin\n" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "hello-stdin\n");
  });

  it("forwards Buffer stdin", async () => {
    const result = await spawnCaptured("node", [
      "-e",
      "let s=Buffer.alloc(0); process.stdin.on('data', c => { s = Buffer.concat([s, c]); }); process.stdin.on('end', () => process.stdout.write(s));",
    ], { stdin: Buffer.from("buf-in") });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "buf-in");
  });

  it("honors cwd and env", async () => {
    const cwd = process.cwd();
    const result = await spawnCaptured(
      process.execPath,
      ["-e", "process.stdout.write(process.cwd() + '|' + process.env.MCP_TEST_ENV)"],
      { cwd, env: { ...process.env, MCP_TEST_ENV: "yes" } },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), `${cwd}|yes`);
  });

  it("rejects when stdout exceeds maxBytes", async () => {
    const size = 2000;
    const maxBytes = 1000;
    const script = `process.stdout.write(Buffer.alloc(${size}).fill("x"));`;
    await assert.rejects(
      () => spawnCaptured("node", ["-e", script], { maxBytes, timeoutMs: 5000 }),
      /remote output exceeded/,
    );
  });

  it("rejects when stderr exceeds maxBytes", async () => {
    const size = 2000;
    const maxBytes = 1000;
    const script = `process.stderr.write(Buffer.alloc(${size}).fill("e"));`;
    await assert.rejects(
      () => spawnCaptured("node", ["-e", script], { maxBytes, timeoutMs: 5000 }),
      /remote stderr output exceeded/,
    );
  });

  it("rejects on timeout", async () => {
    await assert.rejects(
      () => spawnCaptured(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 50 }),
      /timed out/,
    );
  });

  it("returns non-zero exit codes without throwing", async () => {
    const result = await spawnCaptured(process.execPath, ["-e", "process.exit(42)"]);
    assert.equal(result.code, 42);
  });
});

describe("dockerExecArgs", () => {
  it("builds a basic docker exec argv", () => {
    const args = dockerExecArgs("my-app", "/bin/bash", "echo hi");
    assert.deepEqual(args, ["exec", "my-app", "/bin/bash", "-c", "echo hi"]);
  });

  it("includes workdir, user, and env flags before the container", () => {
    const args = dockerExecArgs("c1", "/bin/sh", "id", {
      workdir: "/app",
      user: "1000:1000",
      env: { FOO: "bar", BAZ: "qux" },
    });
    assert.equal(args[0], "exec");
    const containerIdx = args.indexOf("c1");
    assert.ok(containerIdx > 0);
    assert.ok(args.indexOf("-w") < containerIdx);
    assert.ok(args.indexOf("/app") < containerIdx);
    assert.ok(args.indexOf("-u") < containerIdx);
    assert.ok(args.indexOf("1000:1000") < containerIdx);
    assert.ok(args.indexOf("-e") < containerIdx);
    assert.ok(args.includes("FOO=bar"));
    assert.ok(args.includes("BAZ=qux"));
    assert.deepEqual(args.slice(containerIdx), ["c1", "/bin/sh", "-c", "id"]);
  });

  it("does not include -t (TTY) for non-interactive captured exec", () => {
    const args = dockerExecArgs("c1", "/bin/sh", "true");
    assert.equal(args.includes("-t"), false);
    assert.equal(args.includes("-it"), false);
  });

  // Live regression (2026-07-21): without `docker exec -i`, stdin never reaches
  // the container process. docker_write_file / docker_apply_patch / docker_exec(stdin)
  // then create empty files while still reporting success.
  it("must include -i before the container when stdin will be attached", () => {
    const args = dockerExecArgs("c1", "/bin/sh", "cat > /tmp/x", { stdin: true });
    const iIdx = args.indexOf("-i");
    const cIdx = args.indexOf("c1");
    assert.notEqual(iIdx, -1, "docker exec requires -i to forward stdin into the container");
    assert.ok(iIdx < cIdx, "-i must appear before the container name");
  });

  it("must omit -i when stdin is not requested", () => {
    const withFlag = dockerExecArgs("c1", "/bin/sh", "true", { stdin: true });
    const without = dockerExecArgs("c1", "/bin/sh", "true");
    assert.ok(withFlag.includes("-i"));
    assert.equal(without.includes("-i"), false);
  });
});

describe("dockerInteractiveArgs / dockerBackgroundArgs", () => {
  it("interactive uses -i and never -t", () => {
    const args = dockerInteractiveArgs("c1", "/bin/bash", "read x");
    assert.deepEqual(args, ["exec", "-i", "c1", "/bin/bash", "-c", "read x"]);
    assert.equal(args.includes("-t"), false);
    assert.equal(args.includes("-it"), false);
  });

  it("background keeps stdout attached and never uses -d", () => {
    const args = dockerBackgroundArgs("c1", "/bin/sh", "echo hi");
    assert.deepEqual(args, ["exec", "c1", "/bin/sh", "-c", "echo hi"]);
    assert.equal(args.includes("-d"), false);
  });
});
