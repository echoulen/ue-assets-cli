# ue-assets

Install Unreal Engine plugins and content from GitHub Releases.

Requires Node.js >= 18 and a `GITHUB_TOKEN` with `contents:read` scope.

## Usage

```bash
# Install all plugins
npx ue-assets install --config plugins.json --dir Plugins

# Install all content
npx ue-assets install --config content.json --dir Content

# Force reinstall
npx ue-assets install --config plugins.json --dir Plugins --clean

# Update to latest releases
npx ue-assets update --config plugins.json --dir Plugins
npx ue-assets update MyPlugin --config plugins.json --dir Plugins
```

## Config format

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

Add `"dest": "Content/Foo"` per entry to override the install directory.

A `*-lock.json` is written alongside the config to skip already-installed versions.
