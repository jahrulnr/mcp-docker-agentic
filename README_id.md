# mcp-docker-agentic

MCP server untuk operasi agentic di dalam Docker container. Server menggunakan binary `docker` lokal, sehingga autentikasi, networking, volumes, dan context mengikuti konfigurasi `docker` di mesin kamu.

## Konsep

Ini adalah kembaran Docker dari [`mcp-ssh-agentic`](https://github.com/jahrulnr/mcp-ssh-agentic). Jika SSH server menargetkan `user@host[:port]`, server ini menargetkan **nama atau id Docker container**. Nama tool-nya paralel (`ssh_*` → `docker_*`) sehingga pola penggunaan yang sudah familiar bisa langsung dipakai.

## Menjalankan dengan npx

Setelah rilis, package ada di **npmjs** dan **GitHub Packages** sebagai `@jahrulnr/mcp-docker-agentic`.

**npmjs (paling sederhana):**

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

**GitHub Packages** (butuh PAT `read:packages` di `~/.npmrc`):

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

Container harus sudah ada dan berjalan. Pass nama atau id container sebagai `container`, contoh `my-app` atau `a1b2c3d4`.

## Tools

`docker_ping`, `docker_read_file`, `docker_write_file`, `docker_read_image`, `docker_list_dir`, `docker_mkdir`, `docker_grep`, `docker_apply_patch`, `docker_delete`, `docker_exec`, `docker_interactive_exec`, `docker_interactive_input`, `docker_interactive_close`, `docker_interactive_list`, `docker_cp_to`, `docker_cp_from`, `docker_close`

Contoh:

```text
docker_ping("my-app")
docker_read_file("my-app", "/app/config.json")
docker_write_file("my-app", "/app/.env", "PORT=3000\n")
docker_mkdir("my-app", "/app/releases/42")
docker_list_dir("my-app", "/var/log")
docker_grep("my-app", "TODO", "/app", "*.js")
docker_exec("my-app", "ps aux")

# Command yang butuh input interaktif:
docker_interactive_exec("my-app", "apt-get upgrade")
docker_interactive_input(session_id="abc123", input="Y")
docker_interactive_close("abc123")

docker_cp_to("my-app", "./dist/app.tar.gz", "/app/app.tar.gz")
docker_cp_from("my-app", "/app/logs/app.log", "./app.log")
```

## Catatan Perilaku

- `docker_delete` pakai `rm -f` untuk file dan `rm -rf` hanya jika `recursive=true`.
- `docker_write_file` menulis atau menimpa file di container langsung dari teks. Pakai `append=true` untuk append. Parent directory dibuat otomatis kecuali `create_dirs=false`.
- `docker_mkdir` setara `mkdir -p` di dalam container.
- `docker_exec` punya timeout default 30 detik dan max output 5 MiB. `docker_read_image` mendukung file sampai 20 MiB. `docker_write_file` menerima content sampai 5 MiB. Operasi `docker_cp_*` default timeout 120 detik.
- Semua command container berjalan di dalam non-login, non-interactive shell (`bash --noprofile --norc -c`, fallback `sh -c`) sehingga profile script yang rusak tidak mengganggu output. `docker_exec` selalu mengembalikan `exit_code=N` dan stdout. Jika ada stderr, dimasukkan dalam section `[stderr]`. Exit code non-zero mengeset `isError`, tapi stdout tetap dikembalikan.
- **Session interaktif (TTY):** `docker_interactive_exec` menjalankan `docker exec -it` yang mengalokasikan pseudo-terminal, sehingga program yang butuh terminal nyata (`sudo`, `passwd`, konfirmasi y/N, wizard, REPL) berjalan normal. Server menunggu sampai output diam selama `quiet_ms` (default 500 ms) atau proses selesai, lalu mengembalikan output yang terkumpul plus `session_id`. Lanjutkan dengan `docker_interactive_input` (kosongkan `input` untuk poll saja). Mekanisme ini berdasarkan inaktivitas output, bukan deteksi prompt. Command yang terus mengeluarkan output bisa membuat tool call menunggu lebih lama. Server mengizinkan maksimal 8 session interaktif bersamaan, membersihkan session yang idle lebih dari 10 menit, dan menghentikan semua session aktif saat server exit. Gunakan `docker_interactive_list` untuk melihat session aktif dan `docker_interactive_close` untuk menutup manual.
- `docker_grep` memperlakukan "no matches" sebagai hasil sukses dan tetap mengembalikan partial matches meski beberapa path tidak bisa dibaca.
- `docker_cp_to` dan `docker_cp_from` mendukung `recursive=true` untuk direktori. Parent direktori lokal dibuat otomatis saat download. Parent direktori di container harus sudah ada sebelum upload (gunakan `docker_mkdir` jika perlu).
- `docker_close` adalah no-op karena Docker tidak menyimpan koneksi persisten per tool call.

## Development Lokal

```bash
npm install
npm run check
npm test
npm start
```

Unit test memakai `createMockTransport()` — kontrak Docker yang sama (`exec` / `cp` / `close` / `spawnInteractive`) dijalankan di sandbox lokal tanpa container nyata.

Untuk menguji protokol MCP, gunakan MCP Inspector atau klien MCP lain yang mendukung stdio transport.

## CI / Rilis

GitHub Actions (`.github/workflows/ci.yml`):

1. **Unit test** (setiap branch/PR) — Node 18 / 22 / 24 → `npm run check` + `npm run test:unit`
2. **MCP test** (setelah unit) — matrix Node yang sama × (`node` bin | `npx` dari `npm pack`) dengan `MCP_DOCKER_AGENTIC_MOCK=1`
3. **Push ke `master`** — setelah keduanya pass, jika tag `vX.Y.Z` baru: buat tag → publish ke GitHub Packages + npmjs

Lokal: `npm run test:all`

Bump `version` di `package.json` sebelum merge ke `master` untuk rilis baru. Merge ulang versi yang sama akan melewati tag/publish.

**Secrets:** `NPM_TOKEN`. GitHub Packages memakai `GITHUB_TOKEN` (`packages: write`).
