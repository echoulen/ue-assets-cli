# Module Manifest Design

**Date:** 2026-04-19
**Status:** Draft
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

### Fields

- `version` — the release tag this manifest belongs to. Must match the tag the
  manifest is attached to. Used for sanity check at install time.
- `modules` — object keyed by module name (user-visible identifier).

### Module Entry Fields

| Field    | `artifact` source   | `url` source       | Notes |
|----------|---------------------|--------------------|-------|
| `source` | `"artifact"`        | `"url"`            | Required. Discriminator. |
| `asset`  | asset name in same release | —           | Required for `artifact`. |
| `url`    | —                   | absolute HTTP(S) URL | Required for `url`. |
| `sha256` | optional            | **required**       | Hex-encoded SHA-256 of the ZIP. Mandatory for `url` mode; GitHub already guarantees artifact integrity. |

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

1. **Fetch manifest.** Use existing GitHub API path to download the
   `manifest.json` asset from the release identified by `repo` + `version`.
   Cached in memory per `(repo, version)` within one CLI run.
2. **Sanity check.** Verify `manifest.version` matches the requested
   `version`. Warn (not fail) on mismatch.
3. **Look up module.** Find `manifest.modules[module]`. Fail with a clear
   "module not found, available: …" message if missing.
4. **Download by source:**
   - `source: "artifact"` — download named asset via GitHub API (existing
     `downloadAsset()` path).
   - `source: "url"` — HTTP GET with optional `Authorization: Bearer
     $R2_TOKEN` header if the env var is set. Stream to temp file with progress
     bar (existing UI).
5. **Verify sha256.**
   - `url` mode: mandatory. Compute sha256 of the downloaded file, compare to
     manifest value. Abort on mismatch (do not extract).
   - `artifact` mode: if `sha256` is present, verify; otherwise skip.
6. **Extract.** Pass to existing `extractZip()`. Auto-detect structure
   (`Plugins/name/*`, `name/*`, flat).
7. **Record lock.** Write `{ version, module, sha256 }` to the lock file.

## Environment Variables

Existing convention preserved:

- `GITHUB_TOKEN` — used for all GitHub API calls (private repo support,
  manifest fetch, artifact download).

New:

- `R2_TOKEN` — when set, attached as `Authorization: Bearer $R2_TOKEN` for
  all `url` mode downloads. When unset, URL requests go without
  authentication. No fallback to GitHub token for URL downloads.

No `authEnv` field in config or manifest — the env var name is fixed by
convention and loaded from `.env` by the existing dotenv setup.

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

- Lock entry exists with same `version` and `module`, and
- Destination directory exists on disk, and
- For `url` mode entries, lock's `sha256` matches manifest's current `sha256`
  (detects publisher-side blob replacement).

`--clean` bypasses all lock checks.

## Backward Compatibility

No changes to existing `asset` and `url` config modes. The CLI selects mode by
field presence:

1. `module` present → manifest-resolver mode (new).
2. `url` present → direct HTTP mode (per issue #3, not yet implemented).
3. `asset` present → GitHub artifact mode (current).

Existing `plugins.json` configs continue to work unchanged.

## Non-Goals

The following are explicitly out of scope for this design:

- **Multi-chunk modules.** One module = one ZIP. Resilience via chunk-level
  retry is deferred. If large modules prove problematic, revisit.
- **Presigned URLs / S3 signing.** URL mode assumes simple Bearer token auth
  or unauthenticated HTTPS. No AWS Signature V4 or presigned URL generation.
- **Auto-discovery of latest version.** `update` command semantics unchanged:
  resolve latest release tag via GitHub API, then re-install.
- **Parallel downloads.** Entries install sequentially in current
  implementation. Parallelism is a separate optimization.
- **Custom manifest asset name.** The manifest is always named
  `manifest.json`. If future flexibility is needed, add a config field then.

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

- `lib/manifest.js` — `fetchManifest(repo, version)`, `resolveModule(manifest, name)`, schema validation.
- `lib/http.js` — generic `downloadUrl(url, destPath, { authHeader })` used by both this design and issue #3.
- `lib/sha256.js` — `verifySha256(filePath, expected)`.

Changes to `lib/install.js`:

- Branch on entry field: `module` / `url` / `asset`.
- Cache manifest per `(repo, version)` within a single `install()` call.

Changes to `lib/lockfile.js`:

- Extend lock entry shape to optionally carry `module` and `sha256`.
- Maintain backward compat reading old entries (plain version strings).

Changes to `lib/update.js`:

- For `module` mode entries, update behavior mirrors artifact mode: resolve
  latest tag, update `version` in config, re-install. Manifest will be
  re-fetched from the new release.

## Open Questions

None at time of writing.

## References

- Issue #3 — generic HTTP(S) source + sha256 + authEnv (superseded; HTTP
  download primitive is now part of this spec).
- Issue #4 — chunked manifest (superseded by this design's simpler
  one-module-one-ZIP rule).
- Cloudflare R2 pricing — https://developers.cloudflare.com/r2/pricing/
