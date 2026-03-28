# ue-assets

CLI to install Unreal Engine plugins and content from GitHub Releases.

Replaces `curl` + `jq` + `unzip` bash scripts with a single Node.js tool.
Works on macOS, Windows, and Linux. Requires Node.js >= 18.

---

## Installation

```bash
npm install -g ue-assets
```

Or use without installing:

```bash
npx ue-assets install ...
```

Authentication is via `GITHUB_TOKEN` environment variable (or a `.env` file at the project root):

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

### `ue-assets install`

Install all entries from a config file.

```bash
ue-assets install [options]
```

| Option | Default | Description |
|---|---|---|
| `--config <file>` | `plugins.json` | Path to config JSON |
| `--dir <directory>` | `Plugins` | Default base install directory (used when entry has no `dest`) |
| `--clean` | `false` | Remove and reinstall all entries, ignoring lock file |

**Examples:**

```bash
# Install all plugins
ue-assets install --config plugins.json --dir Plugins

# Install all content
ue-assets install --config content.json --dir Content

# Force reinstall
ue-assets install --config plugins.json --dir Plugins --clean
```

### `ue-assets update`

Fetch the latest GitHub Release tag for each entry, update the version in the config file, and reinstall.

```bash
ue-assets update [name] [options]
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
ue-assets update --config plugins.json --dir Plugins

# Update one plugin
ue-assets update MyPlugin --config plugins.json --dir Plugins
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

- name: Install plugins
  env:
    GITHUB_TOKEN: ${{ secrets.PLUGIN_TOKEN }}
  run: npx ue-assets install --config plugins.json --dir Plugins

- name: Install content
  env:
    GITHUB_TOKEN: ${{ secrets.PLUGIN_TOKEN }}
  run: npx ue-assets install --config content.json --dir Content
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
