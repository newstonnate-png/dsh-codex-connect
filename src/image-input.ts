/**
 * Read image inputs back out of a session.
 *
 * Image content blocks are present in `tool/result` events: this was verified directly against a
 * live session, which held twenty of them across five sessions. A block carries exactly two keys
 * (`type`, `attachment`) and the reference carries six (`attachmentId`, `mediaType`, `bytes`,
 * `width`, `height`, `name`) — the SHA-256 digest lives *inside* the branded `attachmentId` as a
 * `sha256:` prefix rather than in a field of its own. Key order is not stable between sessions, so
 * every field is read by name.
 *
 * The reference must be carried whole. `attachments.readImage` verifies the stored object against
 * every field of the reference it is given, so reconstructing a reference from an id alone fails
 * with "Stored attachment metadata does not match its reference."
 */

import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Media types the edit route accepts, matching the attachment service allowlist. */
const SUPPORTED_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function isSupportedMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(value)
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Rebuild a complete {@link ImageAttachmentRef} from a stored image block, or undefined when any
 * required field is missing or malformed.
 *
 * The ref is reconstructed in full rather than trusted by reference, so a malformed session record
 * cannot smuggle an incomplete reference into `readImage` and produce a confusing verification
 * failure later.
 */
export function imageRefFromBlock(value: unknown): ImageAttachmentRef | undefined {
  const record = asRecord(value)
  if (record === undefined || record['type'] !== 'image') return undefined
  const ref = asRecord(record['attachment'])
  if (ref === undefined) return undefined
  const attachmentId = ref['attachmentId']
  const name = ref['name']
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) return undefined
  if (!isSupportedMediaType(ref['mediaType'])) return undefined
  if (!positiveSafeInteger(ref['bytes']) || !positiveSafeInteger(ref['width']) || !positiveSafeInteger(ref['height'])) return undefined
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) return undefined
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: ref['mediaType'],
    bytes: ref['bytes'],
    width: ref['width'],
    height: ref['height'],
    ...(name === undefined ? {} : { name }),
  }
}

/**
 * Collect image references from one event's message content, in the order they appear.
 *
 * Deliberately narrow: it reaches only `data.message.content[].content[]`, the one path image
 * blocks are known to occupy, rather than walking the event tree generically. Guessing at shapes
 * risks treating unrelated objects as images.
 */
export function imageRefsInEvent(event: unknown): readonly ImageAttachmentRef[] {
  const eventRecord = asRecord(event)
  if (eventRecord === undefined || eventRecord['type'] !== 'tool/result') return []
  const message = asRecord(asRecord(eventRecord['data'])?.['message'])
  const blocks = message?.['content']
  if (!Array.isArray(blocks)) return []

  const refs: ImageAttachmentRef[] = []
  for (const block of blocks) {
    const inner = asRecord(block)?.['content']
    if (!Array.isArray(inner)) continue
    for (const part of inner) {
      const ref = imageRefFromBlock(part)
      if (ref !== undefined) refs.push(ref)
    }
  }
  return refs
}

/**
 * Return the most recent `count` image references in the session, newest first.
 *
 * Newest-first ordering follows Codex's own `num_last_images_to_include` semantics: "the last N
 * conversation images" means the ones nearest the current turn.
 *
 * Events are read oldest-to-newest and then reversed, so within a single multi-image result the
 * last image of that result is still the most recent one.
 */
export function recentImageRefs(events: readonly unknown[], count: number): readonly ImageAttachmentRef[] {
  if (!Number.isSafeInteger(count) || count < 1) return []
  const newestFirst: ImageAttachmentRef[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const refs = imageRefsInEvent(events[index])
    for (let inner = refs.length - 1; inner >= 0; inner -= 1) {
      const ref = refs[inner]
      if (ref === undefined) continue
      newestFirst.push(ref)
      if (newestFirst.length >= count) return newestFirst
    }
  }
  return newestFirst
}
