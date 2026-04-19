# Module Manifest Design

**Date:** 2026-04-19
**Status:** Draft (v2)
**Related issues:** #3, #4

## Motivation

Large UE asset packs (e.g. Brushify at ~45 GB compressed) do not fit GitHub
Releases' 2 GB per-file limit, yet we still want GitHub Releases to remain the
source of truth for versioning and changelog.

The current CLI supports a single GitHub Release artifact per config entry
(`asset`). We need:

1. **Multiple sub-packages per release.** One release tag (`v1.0.0`) should be
   able to publish many independent sub-packages (e.g. `AlphaBrushes`,
   `Meshes`, `DistanceMeshes`). Consumers pick which to install.
2. **Large-blob support.** Individual sub-packages may exceed GitHub's 2 GB
   limit and must be hosted on object storage (R2 / S3) while still advertised
   via the same release.
3. **Stable consumer abstraction.** Consumer config should not change when a
   sub-package is migrated from GitHub artifact to R2 URL — only the
   publisher-side manifest changes.

## Design Overview

Introduce a `module` field in the consumer config and a `manifest.json`
artifact in each GitHub Release that maps module names to concrete download
sources. The CLI resolves `module` → manifest entry → actual download.

```
consumer config           GitHub Release                  actual blob
---------------           --------------                  -----------
repo + version  ────┐
                    ├──►  manifest.json  ──►  module entry  ──►  artifact ZIP
module  ────────────┘                                      ──►  R2 URL (auth)
```

## Manifest Schema

A release publishes `manifest.json` as one of its assets. Schema:

```json
{
  "schemaVersion": 1,
  "version": "v1.0.0",
  "modules": {
    "AlphaBrushes": {
      "source": "artifact",
      "asset": "AlphaBrushes-v1.0.0.zip"
    },
    "Meshes": {
      "source": "url",
      "url": "https://assets.example.dev/brushify/Meshes-v1.0.0.zip",
      "sha256": "def1234567890..."
    }
  }
}
```

### Top-Level Fields

- `schemaVersion` — integer. Currently `1`. CLI rejects unknown values with a
  clear "manifest schema version N not supported by this CLI" error so older
  installs fail fast rather than silently misbehave.
- `version` — the release tag this manifest belongs to. Must match the tag the
  manifest is attached to. Mismatch is a hard fail (see Install Flow).
- `modules` — object keyed by module name (user-visible identifier).

### Module Entry Fields

| Field    | `artifact` source   | `url` source       | Notes |
|----------|---------------------|--------------------|-------|
| `source` | `"artifact"`        | `"url"`            | Required. Discriminator. |
| `asset`  | asset name in same release | —           | Required for `artifact`. |
| `url`    | —                   | absolute HTTP(S) URL | Required for `url`. |
| `sha256` | optional            | **required**       | Lowercase hex-encoded SHA-256 of the ZIP (uppercase tolerated; comparison normalizes case). Mandatory for `url` mode; GitHub already guarantees artifact integrity. Mismatch always aborts (no extraction). |

## Consumer Config

```json
{
  "dir": "Content/Brushify",
  "content": {
    "Brushify_AlphaBrushes": {
      "repo": "echoulen/Brushify",
      "version": "v1.0.0",
      "module": "AlphaBrushes"
    },
    "Brushify_Meshes": {
      "repo": "echoulen/Brushify",
      "version": "v1.0.0",
      "module": "Meshes"
    }
  }
}
```

Presence of `module` switches an entry to **manifest-resolver mode**. Multiple
entries sharing the same `repo` + `version` fetch the manifest once and reuse
the parsed result within a single CLI invocation.

## Install Flow

For each entry with a `module` field:

1. **Fetch manifest.** Use the existing GitHub API path to download the
   `manifest.json` asset from the release identified by `repo` + `version`.
   Cached in memory per `(repo, version)` for the lifetime of the Node
   process. (A `_resetCacheForTest` hook exists for unit tests.)
   - **Not found:** abort with
     `manifest.json not found in {repo}@{version} (module mode requires it)`.
2. **Validate manifest.** All failures are hard aborts (publisher bugs, not
   recoverable warnings). The CLI checks in this order:
   - **Not a JSON object:** `manifest of {repo}@{version} is not a JSON object`.
   - **Missing `schemaVersion`:** `manifest of {repo}@{version} is missing 'schemaVersion'`.
   - **Unknown `schemaVersion`:** `manifest schemaVersion {N} not supported by this CLI (max: 1)`.
   - **`manifest.version` mismatch with requested `version`:** `manifest version mismatch: release {version} contains manifest declaring {manifest.version}`.
   - **Missing `modules`:** `manifest of {repo}@{version} is missing 'modules'`.
   - **Per-module shape errors** (each module entry validated):
     - Not an object: `module '{name}' in {repo}@{version} is not an object`.
     - Unknown `source`: `module '{name}' has unknown source '{value}' (expected 'artifact' or 'url')`.
     - `source: "artifact"` missing `asset`: `module '{name}' (artifact) is missing 'asset'`.
     - `source: "url"` missing `url`: `module '{name}' (url) is missing 'url'`.
     - `source: "url"` missing `sha256`: `module '{name}': sha256 is required for url source`.
3. **Look up module.** Find `manifest.modules[module]`.
   - **Missing:** abort with
     `module '{name}' not in manifest of {repo}@{version}; available: a, b, c`.
4. **Download by source:**
   - `source: "artifact"` — download named asset via GitHub API (existing
     `downloadAsset()` path).
   - `source: "url"` — HTTP GET with optional `Authorization: Bearer
     $HTTP_AUTH_TOKEN` header if the env var is set. Stream to temp file with
     progress bar (existing UI).
5. **Verify sha256.**
   - `url` mode: mandatory. Compute sha256 of the downloaded file, compare to
     manifest value. Abort on mismatch (do not extract).
   - `artifact` mode: if `sha256` is present, verify and abort on mismatch;
     otherwise skip.
6. **Extract.** Pass to existing `extractZip()`. Auto-detect structure
   (`Plugins/name/*`, `name/*`, flat).
7. **Record lock.** Write `{ version, module, sha256? }` to the lock file.
   `sha256` is recorded when known (always for `url`, conditionally for
   `artifact`) for traceability — not used by skip logic.

## Environment Variables

Existing convention preserved:

- `GITHUB_TOKEN` — used for all GitHub API calls (private repo support,
  manifest fetch, artifact download).

New:

- `HTTP_AUTH_TOKEN` — when set, attached as `Authorization: Bearer
  $HTTP_AUTH_TOKEN` for all `url` mode downloads. When unset, URL requests go
  without authentication. No fallback to GitHub token for URL downloads.

No `authEnv` field in config or manifest — the env var name is fixed by
convention and loaded from `.env` by the existing dotenv setup. Single-token
scope is acknowledged; multi-bucket / per-host token routing is a Non-Goal.

## Lock File

Extended entry shape:

```json
{
  "Brushify_Meshes": {
    "version": "v1.0.0",
    "module": "Meshes",
    "sha256": "def1234567890..."
  }
}
```

Skip install when:

- Lock entry exists with same `version` and `module`, **and**
- Destination directory exists on disk.

Recorded `sha256` is informational only; the skip decision does not re-fetch
the manifest to detect publisher-side blob mutation. Versioned releases are
contractually immutable; if a publisher silently replaces a blob under the same
version, the consumer can force a refresh with `--clean`.

`--clean` bypasses all lock checks.

## Backward Compatibility

The CLI selects mode by field presence:

1. `module` present → manifest-resolver mode (new).
2. `asset` present → GitHub artifact mode (current).

Existing `plugins.json` configs continue to work unchanged. Lock files written
in the legacy bare-string-version format remain readable; the lockfile reader
normalizes both shapes.

**Mode switching.** When a consumer flips an entry from `asset` to `module` (or
back), the existing lock entry will not match the new shape — the skip predicate
requires `module` equality for module-mode entries, and a bare-string lock can
never satisfy that. The CLI therefore reinstalls on the first run after the
switch, which is the correct behavior. Users do not need to manually delete the
lock entry.

> **Note on issue #3.** The previously proposed direct-URL config mode is
> dropped. Direct HTTP(S) downloads now happen exclusively as an internal
> consequence of `source: "url"` entries inside a manifest, so consumers never
> embed URLs or sha256s in their own config. This eliminates the manual sha256
> bookkeeping that motivated the rethink.

## Non-Goals

The following are explicitly out of scope for this design:

- **Direct-URL consumer config (issue #3).** Superseded — see Backward Compat.
- **Multi-chunk modules.** One module = one ZIP. Resilience via chunk-level
  retry is deferred. If large modules prove problematic, revisit.
- **Presigned URLs / S3 signing.** URL mode assumes simple Bearer token auth
  or unauthenticated HTTPS. No AWS Signature V4 or presigned URL generation.
- **Multi-bucket / per-host token routing.** Single global `HTTP_AUTH_TOKEN`.
  If multiple URL-mode hosts need different credentials in the same install,
  revisit then.
- **Auto-discovery of latest version.** `update` command semantics unchanged:
  resolve latest release tag via GitHub API, then re-install. For
  `module`-mode entries, the new release's manifest is re-fetched.
  - If the new release lacks the requested module, abort with the same
    "module not in manifest" error from Install Flow step 3, after rolling
    back the config version (mirroring existing `installOne` rollback).
- **Parallel downloads.** Entries install sequentially in current
  implementation. Parallelism is a separate optimization.
- **Custom manifest asset name.** The manifest is always named
  `manifest.json`. If future flexibility is needed, add a config field then.
- **Publisher-side manifest tooling.** No `ue-assets manifest gen` subcommand
  in this CLI — publishers use shell scripts (see Author-Side Workflow). May
  be revisited as a separate, opt-in helper if friction proves real.

## Author-Side Workflow (Informative)

Publishers use this pattern:

```bash
# 1. Package sub-packs locally
zip -r AlphaBrushes-v1.0.0.zip Content/Brushify/AlphaBrushes/
zip -r Meshes-v1.0.0.zip Content/Brushify/Meshes/

# 2. Upload large packs to R2
rclone copy Meshes-v1.0.0.zip r2:brushify-assets/

# 3. Compute sha256 for R2 uploads
SHA_MESHES=$(shasum -a 256 Meshes-v1.0.0.zip | awk '{print $1}')

# 4. Generate manifest.json
cat > manifest.json <<EOF
{
  "schemaVersion": 1,
  "version": "v1.0.0",
  "modules": {
    "AlphaBrushes": {
      "source": "artifact",
      "asset": "AlphaBrushes-v1.0.0.zip"
    },
    "Meshes": {
      "source": "url",
      "url": "https://assets.example.dev/brushify/Meshes-v1.0.0.zip",
      "sha256": "$SHA_MESHES"
    }
  }
}
EOF

# 5. Create GitHub Release with manifest + small artifact ZIPs
gh release create v1.0.0 \
  manifest.json \
  AlphaBrushes-v1.0.0.zip \
  --repo echoulen/Brushify
```

The author may script this (outside ue-assets CLI scope).

## Implementation Impact

New modules under `lib/`:

- `lib/manifest.js` — `fetchManifest(repo, version)`,
  `resolveModule(manifest, name)`, schema/version validation.
- `lib/http.js` — generic `downloadUrl(url, destPath, { authHeader })`. Used
  internally for `source: "url"` modules; not exposed via consumer config.
- `lib/sha256.js` — `verifySha256(filePath, expected)`.

Changes to `lib/install.js`:

- Branch on entry field: `module` (new) vs `asset` (existing).
- Cache manifest per `(repo, version)` within a single `install()` call.

Changes to `lib/lockfile.js`:

- Extend lock entry shape to optionally carry `module` and `sha256`.
- Maintain backward compat reading old entries (plain version strings).

Changes to `lib/update.js`:

- For `module` mode entries, update behavior mirrors artifact mode: resolve
  latest tag, update `version` in config, re-install. The new release's
  manifest is re-fetched. Missing-module on the new release rolls back the
  config version, consistent with existing artifact-mode rollback.
- A module's `source` may legitimately differ between releases (e.g. a
  publisher promotes a small artifact-mode pack to a `url`-mode R2 blob in a
  later version). The consumer config never encodes `source`, so this is
  transparent — `update` simply re-resolves the module against the new
  manifest and downloads from whichever source it now points at.

## Open Questions

None at time of writing.

## References

- Issue #3 — generic HTTP(S) source + sha256 + authEnv (superseded; URL
  download is now an internal consequence of manifest `source: "url"` entries,
  not a consumer-facing config mode).
- Issue #4 — chunked manifest (superseded by this design's simpler
  one-module-one-ZIP rule).
- Cloudflare R2 pricing — https://developers.cloudflare.com/r2/pricing/
