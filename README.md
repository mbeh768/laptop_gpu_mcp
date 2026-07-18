# laptop-gpu-mcp

A minimal MCP (Model Context Protocol) server for running Python scripts on a remote machine over HTTP. Expose your Python environment to Claude as discoverable, schema-validated tools instead of hand-rolling SSH commands.

## What this does

Exposes three tools to Claude:

- **`list_scripts`** — discover `.py` files in your scripts directory
- **`run_python`** — execute a script in a specific conda environment; optionally run in background and poll results
- **`job_status`** — check status or list all running jobs

Claude can call these like function calls, with automatic parameter validation and error handling.

## Why MCP instead of SSH?

Instead of: `ssh user@host 'python script.py ...'` with manual parsing of output
You get: Claude sees `run_python(script, env, args, background, timeout)` as a typed tool

Benefits:
- Claude reasons about which tool to use
- Parameters are validated before execution (e.g., rejects path traversal, invalid conda envs)
- Background jobs get tracked with job IDs that Claude can poll later
- If you add tools later, Claude discovers them automatically

## Customize for your setup

Clone this repo and edit these files:

### 1. Configuration

Copy the example config and edit it for your machine:

```bash
cp config.example.json config.json
```

```jsonc
{
  "scriptsBaseDir": "/home/youruser/scripts",   // Where your .py files live
  "condaBaseDir": "/home/youruser/miniconda3",  // Your conda installation
  "host": "0.0.0.0",                            // Listen on all interfaces
  "port": 8420                                  // HTTP port (change if in use)
}
```

Every conda environment found under `condaBaseDir/envs` is exposed automatically —
there's no allowlist to maintain. `config.json` is gitignored, so your paths
never get committed. Every setting can also be overridden with an environment
variable (`SCRIPTS_BASE_DIR`, `CONDA_BASE_DIR`, `MCP_HOST`, `MCP_PORT`) — handy
for one-off runs or systemd units. Env vars take precedence over `config.json`.

### 2. Security: Firewall and auth

This server has **no authentication**. It's safe only on private networks.

If running on a machine you control (same network, no internet exposure):
- Allow the port through your firewall for the remote client's subnet
- Example (Linux): `sudo ufw allow from 10.0.0.0/24 to any port 8420`
- Example (Windows): netsh or Windows Defender firewall rules

If you need to expose this beyond a trusted network, add auth before deploying.

### 3. Optional: Persistent background service

To survive reboots, use systemd (Linux) or Task Scheduler (Windows). Examples in `NOTES.md`.

## Quick start

```bash
npm install
npm run build
npm start          # Listens on http://0.0.0.0:8420/mcp

# Or for development (no build step):
npm run dev
```

Health check: `curl http://localhost:8420/health`

## Connecting from Claude

### Claude Code CLI
```bash
claude mcp add --transport http my-remote-python http://<server-ip>:8420/mcp
```
(Replace `<server-ip>` with your server's IP — this repo keeps real deployment
addresses out of git in a gitignored `address_book.json`, see `.gitignore`)

### Claude Desktop
Settings → Connectors → Add custom connector, use the same URL.

After connecting, Claude will see your three tools and can call them directly.

## Example usage

**Run a script in the foreground:**
```
Claude: run_python(script="train.py", env="pytorch", args=["--epochs", "10"])
→ Blocks until done, returns stdout/stderr
```

**Start a long job in the background:**
```
Claude: run_python(script="preprocess.py", env="data", background=true)
→ Returns job_id immediately (e.g., "job_abc123")

Claude: job_status(job_id="job_abc123")
→ Check progress, returns status and logs
```

## Testing

Included test scripts:
- `src/hello.py` — simple foreground test
- `src/slow.py` — long-running background test

Adapt these to verify your setup works.

## Known limitations

- **No persistence on crash.** If the server process dies, jobs die with it. Use a systemd service or Task Scheduler to auto-restart (see `NOTES.md` for deployment details and known issues).
- **Single machine only.** This server runs Python on *one* remote machine. To run on multiple machines, deploy one server per machine.
- **No job persistence.** Job state lives only in memory; reboots lose it.

## Next steps

1. Clone this repo
2. Set `SCRIPTS_BASE_DIR`, `CONDA_BASE_DIR` for your machine
3. `npm install && npm run build && npm start`
4. Test connectivity: `curl http://your-server:8420/health`
5. Add the HTTP connector to Claude Code/Desktop
6. Try calling the tools

See `NOTES.md` for deployment troubleshooting and operational notes.
