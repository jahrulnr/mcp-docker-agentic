import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_TEXT_BYTES,
  appendToSessionBuffer,
  combineStreams,
  decodeUtf8,
  drainSessionOutput,
  errorResult,
  formatBytes,
  formatFailure,
  parseTarget,
  remoteApplyPatchCommand,
  remoteGrepCommand,
  remoteListDirCommand,
  remotePingCommand,
  remoteReadFileCommand,
  remoteShellCommand,
  remoteWriteVerifyCommand,
  preparePatchForRemote,
  safe,
  settleSession,
  shellQuote,
  textResult,
} from "../src/util.js";

describe("parseTarget", () => {
  it("accepts a container name", () => {
    assert.equal(parseTarget("my-app"), "my-app");
  });

  it("accepts a container id", () => {
    assert.equal(parseTarget("a1b2c3d4"), "a1b2c3d4");
  });

  it("rejects empty", () => {
    assert.throws(() => parseTarget("  "), /required/);
  });

  it("rejects names with spaces", () => {
    assert.throws(() => parseTarget("my app"), /spaces/);
  });

  it("rejects leading dash", () => {
    assert.throws(() => parseTarget("--rm"), /invalid/);
  });

  it("rejects leading slash", () => {
    assert.throws(() => parseTarget("/evil"), /invalid/);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseTarget("  my-app  "), "my-app");
  });

  it("accepts dotted and underscored names", () => {
    assert.equal(parseTarget("my_app.prod-1"), "my_app.prod-1");
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    assert.equal(shellQuote("hello"), "'hello'");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  });
});

describe("remoteShellCommand", () => {
  it("uses non-login bash with -- separator and quoted command", () => {
    const cmd = remoteShellCommand("echo hi");
    assert.match(cmd, /bash --noprofile --norc -c -- 'echo hi'/);
    assert.doesNotMatch(cmd, /bash -lc|sh -lc/);
  });
});

describe("remoteListDirCommand", () => {
  it("uses ls -lAh for metadata-rich listing", () => {
    const cmd = remoteListDirCommand("/tmp/listed");
    assert.match(cmd, /LC_ALL=C ls -lAh --/);
    assert.match(cmd, /\/tmp\/listed/);
  });
});

describe("remoteReadFileCommand", () => {
  it("reads whole file by default", () => {
    assert.match(remoteReadFileCommand("/tmp/x"), /cat -- '\/tmp\/x'/);
  });

  it("limits line count from the start", () => {
    assert.match(remoteReadFileCommand("/tmp/x", 1, 50), /head -n 50/);
  });

  it("starts from an offset", () => {
    assert.match(remoteReadFileCommand("/tmp/x", 10, 0), /tail -n \+10/);
  });

  it("combines offset and limit", () => {
    const cmd = remoteReadFileCommand("/tmp/x", 5, 20);
    assert.match(cmd, /tail -n \+5 \| head -n 20/);
  });
});

describe("remoteGrepCommand", () => {
  it("prefers rg and formats file:line:match", () => {
    const cmd = remoteGrepCommand({ pattern: "TODO", path: "/src" });
    assert.match(cmd, /rg --no-heading -n --hidden --no-messages --/);
    assert.match(cmd, /TODO/);
    assert.match(cmd, /\/src/);
  });

  it("adds ripgrep option flags", () => {
    const cmd = remoteGrepCommand({
      pattern: "foo",
      path: "/src",
      glob: "*.js",
      ignoreCase: true,
      fixedStrings: true,
      wordRegexp: true,
      invert: true,
      maxResults: 10,
    });
    assert.match(cmd, /--glob '\*\.js'/);
    assert.match(cmd, /-i -F -w -v -m 10/);
  });
});

describe("remoteApplyPatchCommand", () => {
  it("includes apply_patch and patch -p0 for strip=0", () => {
    const cmd = remoteApplyPatchCommand();
    assert.match(cmd, /apply_patch/);
    assert.match(cmd, /patch -p0/);
    assert.match(cmd, /rm -f "\$tmpfile"/);
    assert.doesNotMatch(cmd, /rm -f \\+"tmpfile\\+"/);
  });

  it("supports strip level", () => {
    const cmd = remoteApplyPatchCommand({ strip: 1 });
    assert.match(cmd, /git apply -p1/);
    assert.doesNotMatch(cmd, /apply_patch/);
  });

  it("supports dry-run", () => {
    const cmd = remoteApplyPatchCommand({ dry_run: true });
    assert.match(cmd, /git apply --check/);
    assert.match(cmd, /rm -f "\$tmpfile"/);
  });

  it("cds to / when cdRoot is set", () => {
    const cmd = remoteApplyPatchCommand({ cdRoot: true });
    assert.match(cmd, /CDROOT=\//);
    assert.match(cmd, /MCP_DOCKER_ROOT/);
    assert.match(cmd, /cd -- "\$CDROOT"/);
  });
});

describe("preparePatchForRemote", () => {
  it("leaves relative patches unchanged", () => {
    const patch = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const prepared = preparePatchForRemote(patch);
    assert.equal(prepared.cdRoot, false);
    assert.equal(prepared.patch, patch);
  });

  it("strips leading slashes from absolute headers and sets cdRoot", () => {
    const patch = "--- /tmp/a.txt\n+++ /tmp/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const prepared = preparePatchForRemote(patch);
    assert.equal(prepared.cdRoot, true);
    assert.match(prepared.patch, /^--- tmp\/a\.txt/m);
    assert.match(prepared.patch, /^\+\+\+ tmp\/a\.txt/m);
  });
});

describe("remotePingCommand", () => {
  it("does not require hostname as a hard dependency", () => {
    const cmd = remotePingCommand();
    assert.match(cmd, /id -u/);
    assert.match(cmd, /\/etc\/hostname/);
    assert.match(cmd, /uname -n/);
    assert.match(cmd, /hostname 2>\/dev\/null/);
  });
});

describe("remoteWriteVerifyCommand", () => {
  it("counts bytes for overwrite", () => {
    assert.match(remoteWriteVerifyCommand("/tmp/x", "hi\n", false), /wc -c/);
  });

  it("checks tail length for append", () => {
    assert.match(remoteWriteVerifyCommand("/tmp/x", "hi\n", true), /tail -c 3/);
  });
});

describe("helpers", () => {
  it("formats failure with stderr preference", () => {
    const msg = formatFailure({
      code: 2,
      stdout: Buffer.from("out\n"),
      stderr: Buffer.from("err\n"),
    });
    assert.match(msg, /code 2/);
    assert.match(msg, /err/);
    assert.match(msg, /out/);
  });

  it("formats failure when only stdout is present", () => {
    const msg = formatFailure({
      code: 127,
      stdout: Buffer.from("0\n"),
      stderr: Buffer.from(""),
    });
    assert.match(msg, /code 127/);
    assert.match(msg, /^docker exited with code 127\n0$/);
  });

  it("combineStreams puts stderr in a labeled block", () => {
    assert.equal(combineStreams("hi\n", ""), "hi\n");
    assert.equal(combineStreams("hi", "boom"), "hi\n[stderr]\nboom\n");
    assert.equal(combineStreams("", "only-err"), "only-err\n");
  });

  it("formatBytes", () => {
    assert.equal(formatBytes(100), "100 B");
    assert.equal(formatBytes(2048), "2.0 KiB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MiB");
  });

  it("decodeUtf8", () => {
    assert.equal(decodeUtf8(Buffer.from("hello")), "hello");
  });

  it("textResult and errorResult shape MCP content", () => {
    assert.deepEqual(textResult("ok"), { content: [{ type: "text", text: "ok" }] });
    assert.equal(textResult("bad", { isError: true }).isError, true);
    assert.equal(errorResult(new Error("boom")).isError, true);
    assert.equal(errorResult(new Error("boom")).content[0].text, "boom");
    assert.equal(errorResult("plain").content[0].text, "plain");
  });

  it("safe converts thrown errors into errorResult", async () => {
    const ok = await safe(async () => textResult("fine"));
    assert.equal(ok.isError, undefined);
    assert.equal(ok.content[0].text, "fine");

    const bad = await safe(async () => {
      throw new Error("nope");
    });
    assert.equal(bad.isError, true);
    assert.equal(bad.content[0].text, "nope");
  });

  it("exposes a 5 MiB text byte budget", () => {
    assert.equal(MAX_TEXT_BYTES, 5 * 1024 * 1024);
  });
});

describe("session buffer helpers", () => {
  it("appendToSessionBuffer truncates from the head when over budget", () => {
    const session = { chunks: [], bufferedBytes: 0, truncated: false };
    appendToSessionBuffer(session, Buffer.from("AAAA"), 6);
    appendToSessionBuffer(session, Buffer.from("BB"), 6);
    appendToSessionBuffer(session, Buffer.from("CCCC"), 6);
    assert.equal(session.truncated, true);
    assert.ok(session.bufferedBytes <= 6);
    const text = Buffer.concat(session.chunks).toString("utf8");
    assert.equal(text.includes("AAAA"), false);
    assert.match(text, /C/);
  });

  it("drainSessionOutput clears chunks and returns truncation flag", () => {
    const session = {
      chunks: [Buffer.from("one"), Buffer.from("two")],
      bufferedBytes: 6,
      truncated: true,
    };
    const drained = drainSessionOutput(session);
    assert.equal(drained.text, "onetwo");
    assert.equal(drained.truncated, true);
    assert.equal(session.chunks.length, 0);
    assert.equal(session.bufferedBytes, 0);
    assert.equal(session.truncated, false);
  });

  it("settleSession resolves when quiet or exited", async () => {
    const quiet = { exited: false, lastDataAt: Date.now() - 1000 };
    await settleSession(quiet, { quietMs: 50, maxWaitMs: 1000 });

    const exited = { exited: true, lastDataAt: Date.now() };
    await settleSession(exited, { quietMs: 5000, maxWaitMs: 5000 });
  });
});

describe("remoteShellCommand quoting", () => {
  it("preserves quoted payload inside the outer shellQuote", () => {
    const cmd = remoteShellCommand("echo 'hello world'");
    assert.match(cmd, /bash --noprofile --norc -c -- 'echo '\\''hello world'\\'''/);
  });
});
