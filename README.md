# ue-assets

CLI to install Unreal Engine plugins and content from GitHub Releases.

Replaces `curl` + `jq` + `unzip` bash scripts with a single Node.js tool.
Works on macOS, Windows, and Linux. Requires Node.js >= 18.

---

## Installation

```bash
npm install
```

Authentication is via `GITHUB_TOKEN` environment variable (or a `.env` file in the directory you run the CLI from):

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

---

## Config file format

The CLI reads a JSON config file that maps named entries to GitHub Release assets.

**plugins.json** (root key: `plugins`, installs to `Plugins/{name}/`):
```json
{
  "plugins": {
    "MyPlugin": {
      "repo": "owner/repo",
      "version": "v1.2.3",
      "asset": "MyPlugin-{version}.zip"
    }
  }
}
```

**content.json** (root key: `content`, each entry has its own `dest`):
```json
{
  "content": {
    "XANDRA": {
      "repo": "owner/repo",
      "version": "v0.0.1",
      "asset": "XANDRA-{version}.zip",
      "dest": "Content/XANDRA"
    }
  }
}
```

- `repo` — GitHub repository in `owner/name` format
- `version` — Release tag to install
- `asset` — Asset filename; `{version}` is replaced with the tag
- `dest` — *(optional)* Destination path relative to the project root. If omitted, installs to `{--dir}/{name}/`

A lock file (`*-lock.json`) is written next to the config file to track installed versions and skip already-installed entries.

---

## Commands

### `install`

Install all entries from a config file.

```bash
node cli.js install [options]
```

| Option | Default | Description |
|---|---|---|
| `--config <file>` | `plugins.json` | Path to config JSON |
| `--dir <directory>` | `Plugins` | Default base install directory (used when entry has no `dest`) |
| `--clean` | `false` | Remove and reinstall all entries, ignoring lock file |

**Examples:**

```bash
# Install all plugins
node cli.js install --config plugins.json --dir Plugins

# Install all content
node cli.js install --config content.json --dir Content

# Force reinstall
node cli.js install --config plugins.json --dir Plugins --clean
```

### `update`

Fetch the latest GitHub Release tag for each entry, update the version in the config file, and reinstall.

```bash
node cli.js update [name] [options]
```

| Argument | Description |
|---|---|
| `[name]` | *(optional)* Update only this specific entry |

| Option | Default | Description |
|---|---|---|
| `--config <file>` | `plugins.json` | Path to config JSON |
| `--dir <directory>` | `Plugins` | Default base install directory |

**Examples:**

```bash
# Update all plugins to latest
node cli.js update --config plugins.json --dir Plugins

# Update one plugin
node cli.js update MyPlugin --config plugins.json --dir Plugins
```

---

## Zip extraction logic

The CLI auto-detects the zip structure and extracts accordingly:

| Structure | Detection | Behaviour |
|---|---|---|
| `Plugins/{name}/...` | Standard UE5 plugin zip | Extracts contents of `Plugins/{name}/` into dest |
| `{name}/...` | Direct folder zip | Extracts contents of `{name}/` into dest |
| flat | Everything else | Extracts all files directly into dest |

---

## CI usage (GitHub Actions)

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '22'

- name: Install CLI deps
  run: npm install
  working-directory: scripts/ue-assets   # or wherever this package lives

- name: Install plugins
  env:
    GITHUB_TOKEN: ${{ secrets.PLUGIN_TOKEN }}
  run: node scripts/ue-assets/cli.js install --config plugins.json --dir Plugins

- name: Install content
  env:
    GITHUB_TOKEN: ${{ secrets.PLUGIN_TOKEN }}
  run: node scripts/ue-assets/cli.js install --config content.json --dir Content
```

---

## Project structure

```
cli.js          ← Commander.js entry point
lib/
  github.js     ← Octokit API calls + asset download (Node 18 fetch)
  lockfile.js   ← Read/write *-lock.json
  extract.js    ← adm-zip extraction with UE5 structure detection
  install.js    ← install command logic
  update.js     ← update command logic
package.json
```

## Dependencies

| Package | Purpose |
|---|---|
| `commander` | CLI argument parsing |
| `@octokit/rest` | GitHub REST API (auth, release metadata) |
| `adm-zip` | Zip extraction |
| `chalk` | Terminal colours |
| `dotenv` | `.env` file loading |
