/**
 * Live image-edit acceptance, opt-in.
 *
 * Runs one real generation and one real edit against the service, then checks that the edited
 * image reached the session on disk. It SPENDS IMAGE QUOTA, so it is skipped unless
 * `DSH_LIVE_IMAGE_EDIT=1` is set:
 *
 *   # PowerShell
 *   $env:DSH_LIVE_IMAGE_EDIT=1; npx vitest run tests/image-edit-live.spec.ts
 *
 * `LIVE_IMAGE_EDIT` is also accepted. The rest of the image suite uses a stubbed transport and
 * cannot show that an edit reaches the conversation; this file is what closes that gap.
 */

import { describe, expect, it } from 'vitest'
import { runLiveImageEdit } from '../scripts/image-edit-live-smoke.mjs'

const enabled = process.env.DSH_LIVE_IMAGE_EDIT === '1' || process.env.LIVE_IMAGE_EDIT === '1'

describe.skipIf(!enabled)('live image edit acceptance', () => {
  it('edits a generated image and persists the result into the session', async () => {
    const report = await runLiveImageEdit()
    // Surface the whole report on failure rather than a bare boolean.
    expect(report.ok === true ? null : report).toBeNull()
    expect(report.generated).not.toBe(false)
    expect(report.resolverFound).toBe(true)
    expect(report.edited).not.toBe(false)
    expect(report.persisted).toBe(true)
    expect(report.persistedBlockVerified).toBe(true)
    expect(report.outputIsNewBytes).toBe(true)
  }, 600_000)
})
