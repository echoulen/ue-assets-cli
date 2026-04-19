# ue-assets

Install Unreal Engine plugins and content from GitHub Releases.

Requires Node.js >= 18 and a `GITHUB_TOKEN` with `contents:read` scope. For
manifest entries whose `source` is `url` and points to a private bucket, set
`HTTP_AUTH_TOKEN` — sent as `Authorization: Bearer <token>`.

## Usage

```bash
# Install all plugins (defaults: --config plugins, dir from config or Plugins/)
npx ue-assets install

# Install content
npx ue-assets install --config content

# Override install directory via CLI
npx ue-assets install --dir ./MyPlugins

# Force reinstall
npx ue-assets install --clean

# Update to latest releases
npx ue-assets update
npx ue-assets update MyPlugin
```

`--config` defaults to `plugins` (resolves to `plugins.json`). Any name without an extension gets `.json` appended automatically.

## Config format

```json
{
  "dir": "../../Plugins",
  "plugins": {
    "MyPlugin": {
      "repo": "owner/repo",
      "version": "v1.2.3",
      "asset": "MyPlugin-{version}.zip"
    }
  }
}
```

- `"dir"` (optional): default install directory; CLI `--dir` overrides it; falls back to `Plugins/`
- `"dest"` per entry overrides the install directory for that specific asset

### Module mode (multi-pack releases)

For a release that publishes a `manifest.json` listing multiple sub-packages,
reference them by name with `module`:

```json
{
  "dir": "Content/Brushify",
  "content": {
    "Brushify_AlphaBrushes": {
      "repo": "echoulen/Brushify",
      "version": "v1.0.0",
      "module": "AlphaBrushes"
    }
  }
}
```

`module` is mutually exclusive with `asset`. The CLI fetches `manifest.json`
from the release once per `(repo, version)` and resolves the module to either
a GitHub artifact or an external URL transparently. See
[`docs/superpowers/specs/2026-04-19-module-manifest-design.md`](docs/superpowers/specs/2026-04-19-module-manifest-design.md)
for the manifest schema.

A `*-lock.json` is written alongside the config to skip already-installed versions.
