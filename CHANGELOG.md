# Changelog

This file records user-visible changes to the `dsh-codex-connect` plugin. The versioning policy is
in [VERSIONING.md](VERSIONING.md); the machine-readable release highlights remain in
`update-highlights.json`.

## 0.1.0-alpha.4.36 — image editing

### Added

- **Image editing.** `codex_connect_image_generate` accepts input images and can modify existing
  images in addition to generating new ones. New optional tool inputs:
  - `images[]` — `{ kind: "recent" | "asset", assetId?, count?, role? }`.
    - `"recent"` takes the most recent image(s) from the conversation (default 1).
    - `"asset"` takes an exact original previously returned by this plugin, by `assetId`.
  - `mode` — `"generate"` or `"edit"`. Expresses intent only; routing follows the resolved image
    list, not this field.
  - `preserve[]` — invariants folded into the edit instruction (for example `"keep the face
    identical"`).
- Results now carry `operation: "generate" | "edit"` in their presentation metadata, and the result
  card is labelled **Image edited** rather than **Image generated** for an edit. The field is
  optional on read, so sessions written before this release still decode and are treated as
  generations.

### Changed

- Requests carrying input images are sent to the service's image-**edit** route
  (`/backend-api/codex/images/edits`). This is required, not cosmetic: the generation route accepts
  an `images` field and silently ignores it, returning a plausible image built from none of the
  inputs.
- `mode: "edit"` with no resolvable input image is an error. It never falls back to generating a new
  image, which would look like a successful edit.
- The tool's input schema is no longer limited to a single `prompt` field. `size`, `quality`,
  `background`, and `n` are still rejected explicitly, because the service silently ignores invalid
  values for them instead of reporting an error.
- Tool description and the `imageModelHint` reference text updated accordingly.

### Notes and limits

- Up to 20 input images per request, matching `ctx.attachments.imageLimits.maxImagesPerMessage`.
- Input images are transmitted as base64 data URIs. `file_id` addresses OpenAI-hosted files and is
  not usable here, since the plugin has no upload channel.
- An `attachmentId`-only input kind is deliberately **not** offered: `ctx.attachments.readImage`
  verifies the stored object against every field of the reference it is given, and the service
  exposes no id-to-reference lookup, so such an input could not resolve.
- Verification is offline: unit and integration tests cover routing, request shape, input
  resolution, and result metadata. A real-account end-to-end edit against the live service was
  **not** run as part of this release.
- The design contract in [`docs/design/codex-connect-images-v4.md`](docs/design/codex-connect-images-v4.md)
  was extended in §4, §4a, §4b, and §6 to describe editing, which it previously did not claim.
