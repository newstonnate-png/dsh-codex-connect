/**
 * Image-edit path.
 *
 * The behaviours asserted here are the ones an empirical probe established, and they are the ones
 * whose failure would be silent rather than loud:
 *
 *   - routing follows the PRESENCE of resolved images, not the model's stated `mode`, because
 *     `/generations` accepts an `images` field and ignores it, returning a plausible image that
 *     used none of the inputs;
 *   - `mode: "edit"` with nothing resolvable fails instead of quietly generating;
 *   - the whole `ImageAttachmentRef` reaches `readImage`, since an id-only reference fails the
 *     service's metadata verification.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { imageGenerateTool, IMAGE_GENERATE_TOOL_NAME } from '../src/image-tool.ts'
import type { OpenAICodexImageAssetStore } from '../src/image-assets.ts'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

/** A stored image reference exactly as a session event carries it. */
function storedRef(id: string, bytes: number): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes,
    width: 8,
    height: 8,
    name: `${id}.png`,
  }
}

/** One `tool/result` event carrying image blocks at the known path. */
function imageEvent(refs: readonly ImageAttachmentRef[]): unknown {
  return {
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          content: refs.map(ref => ({ type: 'image', attachment: { ...ref } })),
        }],
      },
    },
  }
}

async function setup(options: {
  events?: readonly unknown[]
  limits?: Partial<ImageAttachmentLimits>
  resolveRef?: (attachmentId: string) => ImageAttachmentRef | undefined
  storedBytes?: (ref: ImageAttachmentRef) => Uint8Array | undefined
  generated?: readonly string[]
} = {}) {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })

  const readImage = vi.fn(async (ref: ImageAttachmentRef) => {
    // Mirrors the real service: a reference whose fields do not match the stored record fails, and
    // there is no id-to-reference lookup, so an invented reference cannot be repaired here.
    const expected = options.resolveRef?.(ref.attachmentId as string)
    if (expected === undefined
      || expected.mediaType !== ref.mediaType
      || expected.bytes !== ref.bytes
      || expected.width !== ref.width
      || expected.height !== ref.height
      || expected.name !== ref.name) {
      throw new Error('Stored attachment metadata does not match its reference.')
    }
    return { ref: expected, data: options.storedBytes?.(ref) ?? PNG_1X1 }
  })

  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 25_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...options.limits,
    },
    readImage,
    async saveImages(inputs: readonly SaveImageAttachment[]) {
      return inputs.map((input, index) => ({
        attachmentId: `sha256:out${String(index + 1)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      }))
    },
  })

  const payload = (options.generated ?? [b64(PNG_1X1)]).map(b64Json => ({ b64Json }))
  const generateImages = vi.fn(async (_input: { prompt: string }, _context: unknown) => ({
    apiVersion: 1 as const,
    traceId: 'trace-gen',
    elapsedMs: 1,
    responseBytes: PNG_1X1.byteLength,
    images: payload,
    operation: 'generate' as const,
  }))
  const editImages = vi.fn(async (_input: { prompt: string; images: readonly unknown[] }, _context: unknown) => ({
    apiVersion: 1 as const,
    traceId: 'trace-edit',
    elapsedMs: 1,
    responseBytes: PNG_1X1.byteLength,
    images: payload,
    operation: 'edit' as const,
  }))

  const assets = {
    async saveImages(_sessionId: string, inputs: readonly { mediaType: string; width: number; height: number; data: { byteLength: number }; name: string }[]) {
      return inputs.map((input, index) => ({
        assetId: `img_${String(index + 1).padStart(32, '0')}`,
        mediaType: input.mediaType,
        width: input.width,
        height: input.height,
        // The output schema requires `bytes`, so the stub must supply it: an omitted field fails the
        // tool's own lossless-JSON output check rather than surfacing as a missing value.
        bytes: input.data.byteLength,
        name: input.name,
        sha256: 'a'.repeat(64),
      }))
    },
    async removeImages() { /* no-op */ },
    async read() { return undefined },
  } as unknown as OpenAICodexImageAssetStore

  ctx.provide('openaiCodexTransport', { apiVersion: 1, generateImages, editImages })
  ctx.tools.register(imageGenerateTool(ctx, assets))
  return { ctx, generateImages, editImages, readImage }
}

function executor(ctx: Context, events: readonly unknown[] | undefined = undefined) {
  const session = {
    snapshotEvents: () => events ?? [],
    header: { cwd: 'C:\\Project' },
  }
  return (args: unknown) => ctx.tools.execute({
    signal,
    callId: 'image-edit-1' as never,
    name: IMAGE_GENERATE_TOOL_NAME,
    arguments: args,
    agent: { id: 'session-1', options: {}, session } as never,
  })
}

describe('image edit routing', () => {
  it('routes to the edit transport whenever images resolve, even without mode', async () => {
    const ref = storedRef('sha256:aaa', PNG_1X1.byteLength)
    const { ctx, generateImages, editImages } = await setup({
      events: [imageEvent([ref])],
      resolveRef: id => id === ref.attachmentId ? ref : undefined,
    })
    const result = await executor(ctx, [imageEvent([ref])])({
      prompt: 'make the background blue',
      images: [{ kind: 'recent' }],
    })
    expect(result.isError).toBe(false)
    expect(editImages).toHaveBeenCalledOnce()
    // The whole point: a request carrying images must never reach the route that ignores them.
    expect(generateImages).not.toHaveBeenCalled()
    const [input] = editImages.mock.calls[0] as unknown as [{ images: readonly { b64: string; mediaType: string }[] }]
    expect(input.images).toHaveLength(1)
    expect(input.images[0]?.mediaType).toBe('image/png')
    expect(input.images[0]?.b64).toBe(b64(PNG_1X1))
  })

  it('stays on the generation transport when no images are supplied', async () => {
    const { ctx, generateImages, editImages } = await setup()
    const result = await executor(ctx)({ prompt: 'draw a pixel' })
    expect(result.isError).toBe(false)
    expect(generateImages).toHaveBeenCalledOnce()
    expect(editImages).not.toHaveBeenCalled()
  })

  it('fails mode "edit" with no resolvable images instead of generating', async () => {
    const { ctx, generateImages, editImages } = await setup()
    const result = await executor(ctx)({ prompt: 'change it', mode: 'edit' })
    expect(result.isError).toBe(true)
    expect(generateImages).not.toHaveBeenCalled()
    expect(editImages).not.toHaveBeenCalled()
  })

  it('fails when a recent-image request finds nothing rather than generating', async () => {
    const { ctx, generateImages } = await setup({ events: [] })
    const result = await executor(ctx, [])({ prompt: 'change it', images: [{ kind: 'recent' }] })
    expect(result.isError).toBe(true)
    expect(generateImages).not.toHaveBeenCalled()
  })

  it('marks an edit result as an edit so the card cannot present it as a generation', async () => {
    const ref = storedRef('sha256:bbb', PNG_1X1.byteLength)
    const { ctx } = await setup({
      events: [imageEvent([ref])],
      resolveRef: id => id === ref.attachmentId ? ref : undefined,
    })
    const result = await executor(ctx, [imageEvent([ref])])({
      prompt: 'recolour it',
      images: [{ kind: 'recent' }],
    })
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ kind: 'codex-connect-images', operation: 'edit' })
    if (!result.isError) expect(result.value).toMatchObject({ operation: 'edit' })
  })

  it('passes the whole reference to readImage, since an id-only read fails verification', async () => {
    const ref = storedRef('sha256:ccc', PNG_1X1.byteLength)
    const { ctx, readImage } = await setup({
      events: [imageEvent([ref])],
      resolveRef: id => id === ref.attachmentId ? ref : undefined,
    })
    await executor(ctx, [imageEvent([ref])])({ prompt: 'edit', images: [{ kind: 'recent' }] })
    expect(readImage).toHaveBeenCalledOnce()
    expect(readImage.mock.calls[0]?.[0]).toEqual(ref)
  })

  it('takes the newest conversation images first', async () => {
    const older = storedRef('sha256:older', PNG_1X1.byteLength)
    const newer = storedRef('sha256:newer', PNG_1X1.byteLength)
    const { ctx, editImages } = await setup({
      events: [imageEvent([older]), imageEvent([newer])],
      resolveRef: id => (id === older.attachmentId ? older : id === newer.attachmentId ? newer : undefined),
    })
    const result = await executor(ctx, [imageEvent([older]), imageEvent([newer])])({
      prompt: 'edit the newest',
      images: [{ kind: 'recent', count: 1 }],
    })
    expect(result.isError).toBe(false)
    const [input] = editImages.mock.calls[0] as unknown as [{ images: readonly unknown[] }]
    expect(input.images).toHaveLength(1)
  })

  it('rejects unsupported generation parameters rather than letting them be silently ignored', async () => {
    const { ctx, generateImages } = await setup()
    for (const extra of [{ size: '1024x1024' }, { quality: 'high' }, { background: 'transparent' }]) {
      expect((await executor(ctx)({ prompt: 'draw', ...extra })).isError).toBe(true)
    }
    expect(generateImages).not.toHaveBeenCalled()
  })

  it('folds preserve invariants into the instruction sent to the edit route', async () => {
    const ref = storedRef('sha256:ddd', PNG_1X1.byteLength)
    const { ctx, editImages } = await setup({
      events: [imageEvent([ref])],
      resolveRef: id => id === ref.attachmentId ? ref : undefined,
    })
    await executor(ctx, [imageEvent([ref])])({
      prompt: 'make it warmer',
      images: [{ kind: 'recent' }],
      preserve: ['keep the face identical'],
    })
    const [input] = editImages.mock.calls[0] as unknown as [{ prompt: string }]
    expect(input.prompt).toContain('make it warmer')
    expect(input.prompt).toContain('keep the face identical')
  })
})

describe('addressing an attachment by its complete reference', () => {
  it('resolves an arbitrary attachment that is neither recent nor a plugin asset', async () => {
    const ref = storedRef('sha256:eee', PNG_1X1.byteLength)
    // Deliberately no conversation events and no asset store entry: `attachment` is the only path
    // that can reach this image, which is the whole reason the kind exists.
    const { ctx, editImages, readImage } = await setup({ resolveRef: id => id === ref.attachmentId ? ref : undefined })
    const result = await executor(ctx)({
      prompt: 'make it monochrome',
      images: [{ kind: 'attachment', ref: { ...ref } }],
    })
    expect(result.isError).toBe(false)
    expect(editImages).toHaveBeenCalledOnce()
    expect(readImage).toHaveBeenCalledOnce()
    // Every field must survive, because the service verifies the reference field for field.
    expect(readImage.mock.calls[0]?.[0]).toEqual(ref)
  })

  it('rejects an id with no accompanying reference instead of guessing', async () => {
    const ref = storedRef('sha256:fff', PNG_1X1.byteLength)
    const { ctx, editImages } = await setup({ resolveRef: id => id === ref.attachmentId ? ref : undefined })
    const result = await executor(ctx)({
      prompt: 'edit it',
      images: [{ kind: 'attachment', ref: { attachmentId: ref.attachmentId } }],
    })
    expect(result.isError).toBe(true)
    expect(editImages).not.toHaveBeenCalled()
  })

  it('rejects a reference whose fields do not match the stored object', async () => {
    const ref = storedRef('sha256:999', PNG_1X1.byteLength)
    const { ctx, editImages } = await setup({ resolveRef: id => id === ref.attachmentId ? ref : undefined })
    const result = await executor(ctx)({
      prompt: 'edit it',
      images: [{ kind: 'attachment', ref: { ...ref, width: ref.width + 1 } }],
    })
    // A mismatched reference must fail loudly: the alternative is editing the wrong image.
    expect(result.isError).toBe(true)
    expect(editImages).not.toHaveBeenCalled()
  })
})
