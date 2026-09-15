# Changelog

This file records user-visible changes to the `dsh-codex-connect` plugin. The versioning policy is
in [VERSIONING.md](VERSIONING.md); the machine-readable release highlights remain in
`update-highlights.json`.

## 0.1.0-alpha.4.36 — image editing

### Added

- **Image editing.** `codex_connect_image_generate` accepts input images and can modify existing
  images in addition to generating new ones. New optional tool inputs:
  - `images[]` — `{ kind: "recent" | "asset" | "attachment", assetId?, ref?, count?, role? }`.
    - `"recent"` takes the most recent image(s) from the conversation (default 1).
    - `"asset"` takes an exact original previously returned by this plugin, by `assetId`.
    - `"attachment"` takes any DSH attachment, addressed by its **complete** reference in `ref`. An
      id alone is rejected: a stored image is verified against every field of its reference, and no
      id-to-reference lookup exists, so a bare id could never be turned into a valid read.
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

### Fixed

- **A user-attached image was invisible to the tool.** The resolver that `kind: "recent"` uses read
  only `tool/result` events, at `data.message.content[].content[]`. An image a *person* attaches is
  recorded on a `user/message` event instead, at `data.content[]`, as observed in a live session. The
  resolver therefore found nothing when someone attached an image and asked for it to be edited —
  the exact case the feature exists for — while its tests passed, because they only ever seeded
  tool-produced images. Both record shapes are now read, and `tests/image-input.spec.ts` covers each
  one; narrowing the resolver back to the tool-result path fails 7 of those tests.

### Notes and limits

- Up to 20 input images per request, matching `ctx.attachments.imageLimits.maxImagesPerMessage`.
- Input images are transmitted as base64 data URIs. `file_id` addresses OpenAI-hosted files and is
  not usable here, since the plugin has no upload channel.
- An `attachmentId`-only input kind is deliberately **not** offered: `ctx.attachments.readImage`
  verifies the stored object against every field of the reference it is given, and the service
  exposes no id-to-reference lookup, so such an input could not resolve.
- The design contract in [`docs/design/codex-connect-images-v4.md`](docs/design/codex-connect-images-v4.md)
  was extended in §4, §4a, §4b, and §6 to describe editing, which it previously did not claim.

### Verification

- Offline: **84 tests pass** across the transport, tool, input-resolution, presentation, and
  client-view specs. They cover routing, request shape, input resolution from both event shapes,
  result metadata, and explicit rejection of `size`/`quality`/`background`.
- **Live, end to end** (`pnpm run test:live-image-edit`, opt-in because it spends image quota). Four
  real edits were performed, and each result was decoded and **inspected visually** rather than
  inferred from the response or from differing byte counts:
  1. text → a solid **red** 1254×1254 field;
  2. that red image, resolved back out of the session by recency, → a solid **blue** field;
  3. that blue image, addressed through `kind: "attachment"` with its complete reference, → a solid
     **green** field;
  4. that red image again, reached as a **user-attached** image in a session containing no tool
     result at all, → a solid **yellow** field.
  The edited image was written to the real attachment store, persisted into the session log, and
  appeared in the derived conversation history (two image blocks after editing). Driver:
  `tests/image-edit-live.spec.ts`.
- Limits of that live check, stated plainly: it drives the tool through the real registry and
  appends the tool-result event the way DSH does, rather than letting a model decide to call the
  tool, so it does **not** prove model-initiated behaviour. It also leaves no server running and does
  not exercise the GUI's own rendering of the result card. That last check requires installing this
  build into the host profile and restarting DSH; until it is done, the rendered card is unit-tested
  only.
