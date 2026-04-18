# ue-assets

Install Unreal Engine plugins and content from GitHub Releases.

Requires Node.js >= 18 and a `GITHUB_TOKEN` with `contents:read` scope.

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
- `"tagPrefix"` per entry scopes `update` to releases whose tag starts with the prefix — use when a single repo hosts multiple independent version lines (e.g. `designpacks-v1.0.0`, `alphabrushes-v1.0.0`)

A `*-lock.json` is written alongside the config to skip already-installed versions.

### Multiple version lines in one repo

```json
{
  "plugins": {
    "Brushify_DesignPacks": {
      "repo": "echoulen/brushify",
      "tagPrefix": "designpacks-",
      "version": "designpacks-v1.0.0",
      "asset": "Brushify_DesignPacks-{version}.zip"
    }
  }
}
```
