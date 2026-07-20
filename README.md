# mcp-docker-agentic

An MCP server for agentic Docker container operations. It uses the local `docker` binary, so authentication, networking, volumes, and context are whatever `docker` on your machine is configured for.

## Concept

This is the Docker twin of [`mcp-ssh-agentic`](https://github.com/jahrulnr/mcp-ssh-agentic). Where the SSH server targets `user@host[:port]`, this server targets a **Docker container name or id**. The tool names are parallel (`ssh_*` → `docker_*`) so existing muscle memory transfers across.

## Running with npx

After release, the package is on **npmjs** and **GitHub Packages** as `@jahrulnr/mcp-docker-agentic`.

**npmjs (simplest):**

```json
{
  "mcpServers": {
    "docker-agentic": {
      "command": "npx",
      "args": ["-y", "@jahrulnr/mcp-docker-agentic"]
    }
  }
}
```

**GitHub Packages** (needs a PAT with `read:packages` in `~/.npmrc`):

```ini
@jahrulnr:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

```json
{
  "mcpServers": {
    "docker-agentic": {
      "command": "npx",
      "args": ["-y", "--registry=https://npm.pkg.github.com", "@jahrulnr/mcp-docker-agentic"]
    }
  }
}
```

The container must already exist and be running. Pass the container name or id as `container`, for example `my-app` or `a1b2c3d4`.

## Available Tools

`docker_ping`, `docker_read_file`, `docker_write_file`, `docker_read_image`, `docker_list_dir`, `docker_mkdir`, `docker_grep`, `docker_apply_patch`, `docker_delete`, `docker_exec`, `docker_interactive_exec`, `docker_interactive_input`, `docker_interactive_close`, `docker_interactive_list`, `docker_cp_to`, `docker_cp_from`, `docker_close`

Examples:

```text
docker_ping("my-app")
docker_read_file("my-app", "/app/config.json")
docker_write_file("my-app", "/app/.env", "PORT=3000\n")
docker_mkdir("my-app", "/app/releases/42")
docker_list_dir("my-app", "/var/log")
docker_grep("my-app", "TODO", "/app", "*.js")
docker_exec("my-app", "ps aux")

# Commands that may require interactive input:
docker_interactive_exec("my-app", "apt-get upgrade")
docker_interactive_input(session_id="abc123", input="Y")
docker_interactive_close("abc123")

docker_cp_to("my-app", "./dist/app.tar.gz", "/app/app.tar.gz")
docker_cp_from("my-app", "/app/logs/app.log", "./app.log")
```

## Behavior Notes

- `docker_delete` uses `rm -f` for files and `rm -rf` only when `recursive=true`.
- `docker_write_file` writes or overwrites a container file directly from text. Use `append=true` to append instead of overwrite. Parent directories are created automatically unless `create_dirs=false`.
- `docker_mkdir` is equivalent to `mkdir -p` inside the container.
- `docker_exec` has a default timeout of 30 seconds and a maximum output size of 5 MiB. `docker_read_image` supports files up to 20 MiB. `docker_write_file` accepts content up to 5 MiB. `docker_cp_*` operations default to a 120-second timeout.
- All container commands run inside a non-login, non-interactive shell (`bash --noprofile --norc -c`, falling back to `sh -c`) so broken profile scripts cannot corrupt output. `docker_exec` always returns `exit_code=N` along with stdout. If stderr is present, it is included in a `[stderr]` section. Non-zero exit codes set `isError`, but stdout is still returned.
- **Interactive sessions (TTY):** `docker_interactive_exec` runs `docker exec -it`, allocating a pseudo-terminal so programs that require a real terminal (`sudo`, `passwd`, confirmation prompts, setup wizards, REPLs) behave correctly. The server waits until output has been quiet for `quiet_ms` (default: 500 ms) or the process exits, then returns the collected output along with a `session_id`. Continue the session using `docker_interactive_input` (leave `input` empty to simply wait for more output without sending anything). This mechanism is based on output inactivity rather than prompt detection. Commands that continuously produce output may cause the tool call to wait longer. The server allows up to 8 concurrent interactive sessions, automatically cleans up sessions after 10 minutes of inactivity, and terminates all active sessions when the server exits. Use `docker_interactive_list` to view active sessions and `docker_interactive_close` to close them manually.
- `docker_grep` treats "no matches" as a successful result and still returns partial matches even if some paths cannot be read.
- `docker_cp_to` and `docker_cp_from` support `recursive=true` for directories. Local parent directories are created automatically when downloading. Remote parent directories must already exist before uploading (use `docker_mkdir` if needed).
- `docker_close` is a no-op because Docker does not keep a persistent connection per tool call.

## Local Development

```bash
npm install
npm run check
npm test
npm start
```

Unit tests use `createMockTransport()` — the same Docker contract (`exec` / `cp` / `close` / `spawnInteractive`) executed in a local sandbox, without a real container.

To test the MCP protocol, use MCP Inspector or any MCP client that supports stdio transport.

## CI / Release

GitHub Actions (`.github/workflows/ci.yml`):

1. **Unit test** (any branch/PR) — Node 18 / 22 / 24 → `npm run check` + `npm run test:unit`
2. **MCP test** (after unit) — same Node matrix × (`node` bin | `npx` from `npm pack`) with `MCP_DOCKER_AGENTIC_MOCK=1`
3. **Push to `master`** — after both pass, if tag `vX.Y.Z` is new: create tag → publish to GitHub Packages + npmjs

Local: `npm run test:all`

Bump `version` in `package.json` before merging to `master` for a new release. Re-merging the same version skips tag/publish.

**Secrets:** `NPM_TOKEN`. GitHub Packages uses `GITHUB_TOKEN` (`packages: write`).
