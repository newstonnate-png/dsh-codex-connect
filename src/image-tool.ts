/** Model-callable Codex image generation tool. */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { OpenAICodexTransportV1 } from './transport.ts'
import { OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT } from './transport.ts'
import { decodeStrictBase64, estimateBase64Bytes } from './base64.ts'
import { detectEncodedImage } from './image-format.ts'
import type { CodexImageMediaType, DetectedImage } from './image-format.ts'
import type { OpenAICodexOriginalImageRef } from './image-assets-contract.ts'
import type { OpenAICodexImageAssetStore } from './image-assets.ts'
import { recentImageRefs } from './image-input.ts'
import { IMAGE_PRESENTATION_KIND, IMAGE_PRESENTATION_SCHEMA_VERSION, IMAGE_RESULT_PREFIX } from './image-presentation.ts'
import type { ImagePresentationOperation } from './image-presentation.ts'

/** Stable model-callable tool name. */
export const IMAGE_GENERATE_TOOL_NAME = 'codex_connect_image_generate'
const TRANSPORT_SERVICE = 'openaiCodexTransport'
const PROMPT_MAX_LENGTH = 32_000
const MAX_IMAGES_PER_RESPONSE = 4
const CANCELED_REQUEST_NOTE = 'The request may still be processing.'
/** Default number of conversation images pulled by `kind: "recent"` when no count is given. */
const RECENT_DEFAULT_COUNT = 1
/** Per-image role labels. Purely descriptive: order alone decides what the service acts on. */
const IMAGE_ROLES = ['edit-target', 'reference', 'compositing-input'] as const

interface ImageValue {
  /** Which route produced this result; drives the card label. */
  operation: ImagePresentationOperation
  images: Array<{
    original: OpenAICodexOriginalImageRef
    preview: {
      attachmentId: string
      mediaType: CodexImageMediaType
      width: number
      height: number
      bytes: number
      name: string
    }
  }>
}

type ToolContentBlock = ToolExecutionResult['content'][number]

class SafeToolError extends Error {}

function failure(message: string): never {
  throw new SafeToolError(message)
}

/** Convert transport failures to fixed, secret-free user text. */
function fixedTransportMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  switch (code) {
    case 'OPENAI_CODEX_SIGNED_OUT': return 'Sign in to OpenAI Codex before generating images.'
    case 'OPENAI_CODEX_REAUTH_REQUIRED': return 'Renew OpenAI Codex authorization before generating images.'
    case 'OPENAI_CODEX_RATE_LIMITED': return 'Image generation is temporarily unavailable. Try again later.'
    case 'OPENAI_CODEX_TIMEOUT': return `Image generation timed out. ${CANCELED_REQUEST_NOTE}`
    case 'OPENAI_CODEX_CANCELED': return `Image generation was canceled. ${CANCELED_REQUEST_NOTE}`
    case 'OPENAI_CODEX_NETWORK_ERROR': return `The image generation request lost its network connection. ${CANCELED_REQUEST_NOTE}`
    case 'OPENAI_CODEX_UPSTREAM_REJECTED': return 'The image generation request was rejected.'
    case 'OPENAI_CODEX_UPSTREAM_UNAVAILABLE': return 'Image generation is temporarily unavailable.'
    case 'OPENAI_CODEX_RESPONSE_TOO_LARGE': return 'The image generation response exceeded the safe size limit.'
    case 'OPENAI_CODEX_MALFORMED_RESPONSE': return 'The image generation response was unreadable.'
    default: return 'Image generation failed without exposing private response details.'
  }
}

function extension(mediaType: CodexImageMediaType): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)
}

function outputContent(value: ImageValue): ToolContentBlock[] {
  const lines = value.images.map(({ original, preview }, index) =>
    `${String(index + 1)}. original ${original.mediaType}, ${String(original.width)}x${String(original.height)} px, ${String(original.bytes)} bytes; preview ${String(preview.width)}x${String(preview.height)} px, attachment ${preview.attachmentId}`)
  const verb = value.operation === 'edit' ? 'Edited' : 'Generated'
  return [
    { type: 'text', text: `${verb} ${String(value.images.length)} image${value.images.length === 1 ? '' : 's'}:\n${lines.join('\n')}` },
    { type: 'text', text: IMAGE_RESULT_PREFIX + JSON.stringify(value.images) },
    ...value.images.map(({ preview }) => ({
      type: 'image' as const,
      attachment: {
        attachmentId: AttachmentId(preview.attachmentId),
        mediaType: preview.mediaType,
        width: preview.width,
        height: preview.height,
        bytes: preview.bytes,
        name: preview.name,
      },
    })),
  ]
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function previewValue(ref: ImageAttachmentRef, fallbackName: string): ImageValue['images'][number]['preview'] {
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0
    || (ref.mediaType !== 'image/png' && ref.mediaType !== 'image/jpeg' && ref.mediaType !== 'image/webp')
    || !positiveSafeInteger(ref.bytes) || !positiveSafeInteger(ref.width) || !positiveSafeInteger(ref.height)) {
    failure('The attachment store returned invalid preview metadata.')
  }
  const name = typeof ref.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(ref.name)
    ? ref.name
    : fallbackName
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    width: ref.width,
    height: ref.height,
    bytes: ref.bytes,
    name,
  }
}

function executionKey(exec: ToolRunContext): string {
  return `${String(exec.agent?.id ?? '<no-agent>')}\u0000${String(exec.rootCallId)}\u0000${String(exec.callId)}`
}

type TransportResponse = Awaited<ReturnType<OpenAICodexTransportV1['generateImages']>>

/** One request image input as supplied by the model. */
interface ImageInputArg {
  kind: 'asset' | 'recent' | 'attachment'
  assetId?: string
  /** Complete reference for `kind: "attachment"`; see {@link parseAttachmentRef}. */
  ref?: unknown
  count?: number
  role?: (typeof IMAGE_ROLES)[number]
}

/** Fully validated bytes plus the reference they belong to. */
interface ResolvedInput {
  ref: ImageAttachmentRef
  b64: string
}

/**
 * Validate a caller-supplied attachment reference into an `ImageAttachmentRef`.
 *
 * The whole reference is required, not just an id: `attachments.readImage` verifies the stored
 * object against every field of the reference it receives, and the service exposes no
 * id-to-reference lookup, so an id alone can never be turned into a verifiable read. Accepting the
 * complete reference is what lets an attachment that is neither a recent conversation image nor one
 * of this plugin's own assets still be addressed by identity.
 */
function parseAttachmentRef(value: unknown): ImageAttachmentRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failure('kind "attachment" requires `ref` to be an attachment reference object.')
  }
  const record = value as Record<string, unknown>
  const attachmentId = record.attachmentId
  if (typeof attachmentId !== 'string' || !attachmentId.startsWith('sha256:')) {
    failure('kind "attachment" requires `ref.attachmentId` to be a sha256: attachment id.')
  }
  const mediaType = record.mediaType
  if (typeof mediaType !== 'string' || mediaType.length === 0) {
    failure('kind "attachment" requires `ref.mediaType`.')
  }
  for (const field of ['bytes', 'width', 'height'] as const) {
    const number = record[field]
    if (!Number.isSafeInteger(number) || (number as number) < 1) {
      failure(`kind "attachment" requires \`ref.${field}\` to be a positive integer.`)
    }
  }
  // Optional fields are copied only when present, so the rebuilt reference matches the stored
  // object field for field; an extra unrelated key would make verification fail.
  const name = record.name
  const originalDimensions = record.originalDimensions
  let dimensions: { width: number; height: number } | undefined
  if (originalDimensions !== undefined) {
    if (typeof originalDimensions !== 'object' || originalDimensions === null || Array.isArray(originalDimensions)) {
      failure('kind "attachment" requires `ref.originalDimensions` to contain positive width and height values.')
    }
    const size = originalDimensions as Record<string, unknown>
    if (Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
      && (size.width as number) > 0 && (size.height as number) > 0) {
      dimensions = { width: size.width as number, height: size.height as number }
    } else {
      failure('kind "attachment" requires `ref.originalDimensions` to contain positive width and height values.')
    }
  }
  return {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    ...(dimensions === undefined ? {} : { originalDimensions: dimensions }),
  }
}

/**
 * Resolve one model-supplied input descriptor to validated bytes.
 *
 * Three paths can actually resolve: the conversation itself (`recent`), this plugin's own asset
 * store (`asset`), and any DSH attachment addressed by its complete reference (`attachment`).
 *
 * There is deliberately no *id-only* attachment kind. An id alone cannot be verified, because
 * `attachments.readImage` checks the stored object against every field of the reference it receives
 * and no id-to-reference lookup exists; `attachment` therefore demands the whole reference. An input
 * kind that silently cannot work is worse than an absent one.
 */
async function resolveInput(
  ctx: Context,
  assets: OpenAICodexImageAssetStore,
  sessionId: string,
  arg: ImageInputArg,
  events: readonly unknown[] | undefined,
  signal: AbortSignal | undefined,
): Promise<readonly ResolvedInput[]> {
  if (arg.kind === 'attachment') {
    const ref = parseAttachmentRef(arg.ref)
    if (!ctx.attachments.imageLimits.mediaTypes.includes(ref.mediaType as ImageMediaType)) {
      failure(`${ref.mediaType} images are disabled by this deployment.`)
    }
    if (ref.bytes > ctx.attachments.imageLimits.maxImageBytes) {
      failure('An input image exceeds this deployment\'s byte limit.')
    }
    let data: Uint8Array | undefined
    try {
      // The whole reference is passed: the service verifies the stored object against every field.
      data = (await ctx.attachments.readImage(ref, signal)).data
    } catch {
      failure('The referenced attachment could not be read. It may have been pruned; ask for a fresh copy.')
    }
    if (data === undefined || data.byteLength === 0) failure('The referenced attachment is empty.')
    // `name` is re-added only when the caller supplied one: under `exactOptionalPropertyTypes` an
    // explicit `undefined` is not the same as an absent key, and an extra key would break the
    // service's field-for-field verification of the stored object.
    return [{
      ref: ref.name === undefined ? { ...ref } : { ...ref, name: ref.name },
      b64: Buffer.from(data).toString('base64'),
    }]
  }

  if (arg.kind === 'asset') {
    const assetId = arg.assetId
    if (typeof assetId !== 'string' || assetId.length === 0) {
      failure('kind "asset" requires a non-empty assetId.')
    }
    let stored: Awaited<ReturnType<OpenAICodexImageAssetStore['read']>>
    try {
      stored = await assets.read(sessionId, assetId)
    } catch {
      failure('The referenced image asset is not available in this session.')
    }
    // `read` re-derives the digest and dimensions from the bytes on disk and refuses a mismatch,
    // so a returned original is byte-identical to what was generated.
    if (stored === undefined) failure('The referenced image asset is not available in this session.')
    const { ref: original, data } = stored
    if (!ctx.attachments.imageLimits.mediaTypes.includes(original.mediaType as ImageMediaType)) {
      failure(`${original.mediaType} images are disabled by this deployment.`)
    }
    if (data.byteLength > ctx.attachments.imageLimits.maxImageBytes) {
      failure('An input image exceeds this deployment\'s byte limit.')
    }
    return [{
      ref: {
        attachmentId: original.assetId as ImageAttachmentRef['attachmentId'],
        mediaType: original.mediaType,
        bytes: original.bytes,
        width: original.width,
        height: original.height,
        ...(original.name === undefined ? {} : { name: original.name }),
      },
      b64: Buffer.from(data).toString('base64'),
    }]
  }

  // kind === 'recent'
  const count = arg.count ?? RECENT_DEFAULT_COUNT
  if (!Number.isSafeInteger(count) || count < 1 || count > OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT) {
    failure(`The recent-image count must be between 1 and ${String(OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT)}.`)
  }
  if (events === undefined) failure('Recent conversation images are unavailable for this call.')
  const refs = recentImageRefs(events, count)
  if (refs.length === 0) {
    failure('No image was found in this conversation. Attach an image or generate one first.')
  }
  // Short of the request is an error, not a silent smaller edit: quietly editing fewer images than
  // asked for would produce a confident result built from the wrong inputs.
  if (refs.length < count) {
    failure(`Requested the last ${String(count)} conversation image${count === 1 ? '' : 's'}, but only ${String(refs.length)} ${refs.length === 1 ? 'was' : 'were'} available. Ask which image to use instead of guessing.`)
  }
  const resolved: ResolvedInput[] = []
  for (const ref of refs) {
    if (!ctx.attachments.imageLimits.mediaTypes.includes(ref.mediaType)) {
      failure(`${ref.mediaType} images are disabled by this deployment.`)
    }
    if (ref.bytes > ctx.attachments.imageLimits.maxImageBytes) {
      failure('A conversation image exceeds this deployment\'s byte limit.')
    }
    let data: Uint8Array | undefined
    try {
      // The whole reference is passed: the service verifies the stored object against every field.
      data = (await ctx.attachments.readImage(ref, signal)).data
    } catch {
      failure('A conversation image could not be read. It may have been pruned; ask for a fresh copy.')
    }
    if (data === undefined || data.byteLength === 0) failure('A conversation image is empty.')
    resolved.push({ ref, b64: Buffer.from(data).toString('base64') })
  }
  return resolved
}

/** Assemble the request, send it, then persist and describe the result. */
async function submit(
  ctx: Context,
  transport: OpenAICodexTransportV1,
  assets: OpenAICodexImageAssetStore,
  prompt: string,
  inputs: readonly ResolvedInput[],
  exec: ToolRunContext,
): Promise<ImageValue> {
  const operation: ImagePresentationOperation = inputs.length === 0 ? 'generate' : 'edit'
  const invoke = async (): Promise<TransportResponse> => {
    // Routing keys on the PRESENCE of inputs, never on the model's stated mode: the generation
    // route accepts an `images` field and silently ignores it, so a mis-routed edit would return a
    // plausible image that used none of the inputs.
    if (operation === 'edit') {
      return transport.editImages({
        prompt,
        images: inputs.map(input => ({ b64: input.b64, mediaType: input.ref.mediaType })),
      }, { signal: exec.signal })
    }
    return transport.generateImages({ prompt }, { signal: exec.signal })
  }
  let response: TransportResponse
  try {
    response = await invoke()
  } catch (error) {
    failure(fixedTransportMessage(error))
  }

  const limits = ctx.attachments.imageLimits
  if (response.images.length < 1
    || response.images.length > MAX_IMAGES_PER_RESPONSE
    || response.images.length > limits.maxImagesPerMessage) {
    failure('The generated image count exceeds this deployment\'s attachment limit.')
  }

  let estimatedTotal = 0
  const estimates: number[] = []
  for (const image of response.images) {
    const estimate = estimateBase64Bytes(image.b64Json)
    if (estimate === undefined) failure('The image generation response contained invalid image data.')
    if (estimate > limits.maxImageBytes) failure('A generated image exceeds this deployment\'s byte limit.')
    estimatedTotal += estimate
    if (!Number.isSafeInteger(estimatedTotal) || estimatedTotal > limits.maxMessageImageBytes) {
      failure('The generated image batch exceeds this deployment\'s byte limit.')
    }
    estimates.push(estimate)
  }

  const uploads: SaveImageAttachment[] = []
  const parsedImages: DetectedImage[] = []
  for (const [index, image] of response.images.entries()) {
    const data = decodeStrictBase64(image.b64Json)
    if (data === undefined || data.byteLength !== estimates[index]) failure('The image generation response contained invalid image data.')
    const parsed = detectEncodedImage(data)
    if (parsed === undefined) failure('Generated images must be valid PNG, JPEG, or WebP files.')
    if (!limits.mediaTypes.includes(parsed.mediaType as ImageMediaType)) {
      failure(`${parsed.mediaType} images are disabled by this deployment.`)
    }
    if (parsed.width * parsed.height > limits.maxImagePixels) {
      failure('A generated image exceeds this deployment\'s pixel limit.')
    }
    const name = `codex-image-${String(index + 1)}.${extension(parsed.mediaType)}`
    parsedImages.push(parsed)
    uploads.push({ data, mediaType: parsed.mediaType, name })
  }

  const sessionId = exec.agent?.id
  if (sessionId === undefined) failure('Image generation requires a session-owned tool call.')
  let originals: readonly OpenAICodexOriginalImageRef[]
  try {
    originals = await assets.saveImages(String(sessionId), uploads.map((upload, index) => {
      const parsed = parsedImages[index]
      if (parsed === undefined || upload.name === undefined) failure('The generated image batch is incomplete.')
      return {
        data: upload.data,
        mediaType: parsed.mediaType,
        width: parsed.width,
        height: parsed.height,
        name: upload.name,
      }
    }))
  } catch {
    failure('The generated original images could not be saved.')
  }

  let refs: readonly ImageAttachmentRef[]
  try {
    refs = await ctx.attachments.saveImages(uploads)
  } catch {
    await assets.removeImages(originals)
    failure('The generated images could not be saved; no attachment references were returned.')
  }
  if (refs.length !== uploads.length || originals.length !== uploads.length) {
    await assets.removeImages(originals)
    failure('The image stores returned an incomplete image batch.')
  }

  try {
    return {
      operation,
      images: refs.map((ref, index) => {
        const original = originals[index]
        const name = uploads[index]?.name
        if (original === undefined || name === undefined) failure('The image stores returned an incomplete image batch.')
        return { original, preview: previewValue(ref, name) }
      }),
    }
  } catch (error) {
    await assets.removeImages(originals)
    throw error
  }
}

function appendAbortNote(result: Readonly<ToolExecutionResult>): ToolContentBlock[] | undefined {
  if (!result.isError || result.error.info?.code !== TOOL_ABORTED) return undefined
  const existing = result.content.filter((block): block is Extract<ToolContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('\n')
  if (existing.includes(CANCELED_REQUEST_NOTE)) return undefined
  return [...result.content, { type: 'text', text: CANCELED_REQUEST_NOTE }]
}

/** Build one fiber-owned image tool, including in-flight call deduplication. */
export function imageGenerateTool(ctx: Context, assets: OpenAICodexImageAssetStore): ToolDefinition {
  const inFlight = new Map<string, Promise<ImageValue>>()
  return defineTool({
    name: IMAGE_GENERATE_TOOL_NAME,
    description: [
      'Generate a new image from a text prompt, or edit one or more images already available in this conversation.',
      'Supply `images` to edit: any request carrying at least one image is sent to the image-edit route, which reads every input.',
      'Omit `images` entirely to generate a new image from text alone.',
      'Each entry needs `kind`: "recent" pulls the most recent conversation images (the usual choice when the user refers to an image they can see), "asset" targets an original returned by an earlier call by its assetId, and "attachment" addresses any DSH attachment by passing its complete reference in `ref` (an id alone is not accepted, because a stored image is verified against every field of its reference).',
      'List the edit target first — input order is preserved, and the service acts on that order.',
      '`preserve` restates what must not change; repeat it on every iteration to reduce drift.',
      'Output size and style are service defaults; the tool does not accept size, quality, or background.',
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: 'A complete description of the image to generate, or of the change to make when editing.' },
      mode: {
        type: 'string',
        enum: ['generate', 'edit'],
        description: 'Stated intent. Routing follows the resolved `images` list, not this field: supplying images always uses the edit route.',
      },
      images: {
        type: 'array',
        description: 'Input images. Omit for a plain text-to-image generation.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: ['asset', 'recent', 'attachment'] },
            assetId: { type: 'string', description: 'Required when kind is "asset".' },
            ref: {
              type: 'object',
              description: 'Required when kind is "attachment": the complete attachment reference, exactly as it appeared in the conversation.',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                name: { type: 'string' },
                originalDimensions: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                },
              },
            },
            count: { type: 'integer', description: 'How many recent conversation images to take when kind is "recent". Defaults to 1.' },
            role: { type: 'string', enum: [...IMAGE_ROLES], description: 'Descriptive label only; position decides what the service acts on.' },
          },
        },
      },
      preserve: {
        type: 'array',
        items: { type: 'string' },
        description: 'Things that must stay unchanged, e.g. "keep the face identical". Folded into the edit instruction.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: {
            type: 'string',
            required: true,
            enum: ['generate', 'edit'],
          },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                original: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    assetId: { type: 'string', required: true },
                    mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp'] },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                    bytes: { type: 'integer', required: true },
                    name: { type: 'string', required: true },
                    sha256: { type: 'string', required: true },
                  },
                },
                preview: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    attachmentId: { type: 'string', required: true },
                    mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp'] },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                    bytes: { type: 'integer', required: true },
                    name: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => outputContent(value),
      presentationMeta: (args, value) => ({
        kind: IMAGE_PRESENTATION_KIND,
        schemaVersion: IMAGE_PRESENTATION_SCHEMA_VERSION,
        prompt: args.prompt.trim(),
        operation: value.operation,
        images: value.images,
      }),
    },
    // One prompt maps to one request batch, so overlapping calls would spend quota twice.
    isConcurrencySafe: () => false,
    finalizeContent: (_exec, result) => appendAbortNote(result),
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0 || prompt.length > PROMPT_MAX_LENGTH) failure('Image prompt must contain 1 to 32000 characters.')

      // Rejected explicitly rather than ignored. The service does not validate these: it silently
      // ignores values it does not like and reports what it actually used, so accepting them would
      // let the caller believe a size or quality request took effect when it did not.
      for (const unsupported of ['size', 'quality', 'background', 'n'] as const) {
        if (Object.hasOwn(args, unsupported)) {
          failure(`Image ${unsupported} is not supported. Output size and quality are service defaults.`)
        }
      }

      const requested = Array.isArray(args.images) ? args.images : []
      const preserve = Array.isArray(args.preserve) ? args.preserve.filter(entry => entry.trim().length > 0) : []
      if (requested.length > OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT) {
        failure(`This request includes ${String(requested.length)} images; at most ${String(OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT)} can be edited at once.`)
      }
      // `preserve` is folded into the instruction rather than sent as a separate field: the route
      // takes only model/prompt/images, and Codex's own guidance is to restate invariants inline.
      const instruction = preserve.length === 0
        ? prompt
        : `${prompt}\n\nChange only what the instruction above describes. Keep everything else unchanged, in particular: ${preserve.join('; ')}.`

      const transport = ctx.reflect.get(TRANSPORT_SERVICE) as OpenAICodexTransportV1 | undefined
      if (transport?.apiVersion !== 1) failure('The Codex Connect image transport is unavailable.')

      const sessionId = exec.agent?.id
      if (sessionId === undefined) failure('Image generation requires a session-owned tool call.')

      let inputs: readonly ResolvedInput[] = []
      if (requested.length > 0) {
        const events = (() => {
          try {
            return exec.agent?.session.snapshotEvents()
          } catch {
            return undefined
          }
        })()
        const resolved: ResolvedInput[] = []
        for (const arg of requested) {
          resolved.push(...await resolveInput(ctx, assets, String(sessionId), arg, events, exec.signal))
        }
        if (resolved.length > OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT) {
          failure(`This request resolved to ${String(resolved.length)} images; at most ${String(OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT)} can be edited at once.`)
        }
        let total = 0
        for (const input of resolved) {
          total += input.ref.bytes
          if (!Number.isSafeInteger(total) || total > ctx.attachments.imageLimits.maxMessageImageBytes) {
            failure('The combined input images exceed the size limit.')
          }
        }
        inputs = resolved
      }

      // Stated `mode: "edit"` with nothing resolvable is an error, never a silent fallback to
      // generation: a fresh image would look like a successful edit.
      if (inputs.length === 0 && args.mode === 'edit') {
        failure('Editing needs at least one input image. Ask which image to change rather than generating a new one.')
      }

      const key = executionKey(exec)
      const current = inFlight.get(key)
      if (current !== undefined) return current
      const pending = submit(ctx, transport, assets, instruction, inputs, exec)
        .catch(error => { if (error instanceof SafeToolError) throw error; failure(fixedTransportMessage(error)) })
        .finally(() => { inFlight.delete(key) })
      inFlight.set(key, pending)
      return pending
    },
  })
}
