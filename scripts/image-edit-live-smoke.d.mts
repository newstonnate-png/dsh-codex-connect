/**
 * Types for the live image-edit fixture.
 *
 * The fixture is plain JavaScript on purpose: it boots real DSH modules so the edit path runs against
 * the live service rather than a stub, and those modules are resolved by the host at runtime. This
 * declaration exists only so the opt-in spec that imports it stays typechecked rather than silently
 * degrading to `any`.
 */

/** One image the live run produced, as recorded in its evidence report. */
export interface LiveImageRecord {
  mediaType: string
  width: number
  height: number
  bytes: number
}

/** Evidence gathered by a live run. Every field is observed, not assumed. */
export interface LiveImageEditReport {
  ok: boolean
  error?: string
  stack?: string[]
  generated?: LiveImageRecord
  edited?: LiveImageRecord
  generationText?: string
  editText?: string
  resolverFound?: boolean
  resolverRef?: Record<string, unknown>
  sessionEventCount?: number
  sessionArtifacts?: string[]
  persisted?: boolean
  persistedIn?: string[]
  persistedBlockVerified?: boolean
  derivedImageBlocks?: number
  derivedImageBlocksAfterEdit?: number
  bytes?: { input: number; output: number }
  outputIsNewBytes?: boolean
  toolRegistered?: boolean
  pluginApplied?: boolean
  pluginFiberState?: number | string
  diagnostics?: string[]
  sessionRoot?: string
  attachment?: string
  [field: string]: unknown
}

/**
 * Run one live generation and one live edit against the configured account.
 *
 * Never throws for an expected failure: it returns a report whose `ok` is false and whose `error`
 * explains the outcome, so the spec can surface the whole report instead of a bare assertion.
 * Spends real image quota.
 */
export function runLiveImageEdit(): Promise<LiveImageEditReport>
