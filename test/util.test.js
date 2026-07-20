import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  combineStreams,
  decodeUtf8,
  formatBytes,
  formatFailure,
  parseTarget,
  remoteApplyPatchCommand,
  remoteGrepCommand,
  remoteListDirCommand,
  remoteReadFileCommand,
  remoteShellCommand,
  shellQuote,
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
  });

  it("supports strip level", () => {
    const cmd = remoteApplyPatchCommand({ strip: 1 });
    assert.match(cmd, /git apply -p1/);
    assert.doesNotMatch(cmd, /apply_patch/);
  });

  it("supports dry-run", () => {
    const cmd = remoteApplyPatchCommand({ dry_run: true });
    assert.match(cmd, /git apply --check/);
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

  it("combineStreams puts stderr in a labeled block", () => {
    assert.equal(combineStreams("hi\n", ""), "hi\n");
    assert.equal(combineStreams("hi", "boom"), "hi\n[stderr]\nboom\n");
  });

  it("formatBytes", () => {
    assert.equal(formatBytes(100), "100 B");
    assert.equal(formatBytes(2048), "2.0 KiB");
  });

  it("decodeUtf8", () => {
    assert.equal(decodeUtf8(Buffer.from("hello")), "hello");
  });
});
