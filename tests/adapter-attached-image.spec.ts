/**
 * Regression: an image a person attached must survive request preparation.
 *
 * Codex Connect delegates request-image preparation to the host's pi-ai adapter,
 * which resolves a request-image target and hands it to the host's attachment
 * store. Between DSH generations that argument changed shape — a policy
 * (`{maxPixels, maxBytes}`) became a resolved target (`{width, height, maxBytes}`)
 * — while the store's validator still required positive integers under the new
 * names. A plugin pinned to the older adapter therefore failed the store's first
 * statement, and every turn carrying an image ended with
 * `Image request width must be a positive integer.`
 *
 * This drives a real attachment through the real store and the plugin's own
 * adapter, then inspects the request version the store produced. The network is
 * stubbed, so no provider is contacted and no quota is spent.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  OPENAI_CODEX_REQUEST_IMAGE_MAX_BYTES,
  createOpenAICodexAdapter,
} from '../src/adapter.ts'
import { OpenAICodexCredentialStore, OPENAI_CODEX_PROVIDER } from '../src/store.ts'

function crc32(input: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  name.copy(chunk, 4)
  Buffer.from(data).copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength)
  return chunk
}

/** A solid-colour PNG whose source pixels exceed the route's request budget. */
function solidPng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const scanlines = Buffer.alloc((width * 3 + 1) * height)
  const encoded = deflateSync(scanlines, { level: 9 })
  return Uint8Array.from(Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', encoded),
    pngChunk('IEND', Buffer.alloc(0)),
  ]))
}

/** Stand-in for the one-shot SSE stream a provider returns. */
function completedSse(): Response {
  const body = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"spec","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}',
    '',
    '',
  ].join('\n')
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Real credential store holding one signed-in fixture account. */
async function fixtureCredentials(authRoot: string): Promise<OpenAICodexCredentialStore> {
  const store = new OpenAICodexCredentialStore(join(authRoot, 'auth.json'))
  const access = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64')}.fixture`
  await store.modify(OPENAI_CODEX_PROVIDER, async () => ({
    type: 'oauth' as const, accountId: 'fixture-account', access, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000,
  }))
  return store
}

/** One resolved request version, as the store returned it to the adapter. */
interface RequestVersion {
  width: number
  height: number
  bytes: number
  variantId: string
}

let context: Context | undefined
let home: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

async function runAttachedImageRequest(source: Uint8Array) {
  home = await mkdtemp(join(tmpdir(), 'codex-request-image-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  const store = ctx.get('attachments') as LocalAttachmentStore
  // Observe the exact contract the adapter uses, without replacing the real store.
  const requested: RequestVersion[] = []
  const original = store.readImageRequest.bind(store)
  vi.spyOn(store, 'readImageRequest').mockImplementation(async (ref, target, signal) => {
    const version = await original(ref, target, signal)
    requested.push({ width: version.width, height: version.height, bytes: version.bytes, variantId: String(version.variantId) })
    return version
  })
  const ref = await store.saveImage({ data: source, mediaType: 'image/png', name: 'attached.png' })

  const realFetch = globalThis.fetch
  globalThis.fetch = async () => completedSse()
  try {
    const adapter = createOpenAICodexAdapter(await fixtureCredentials(home), () => store)
    const prepared = await adapter.prepareCall(OPENAI_CODEX_PROVIDER, 'gpt-5.6-luna')
    const chunks = []
    for await (const chunk of prepared.stream({
      provider: OPENAI_CODEX_PROVIDER,
      model: prepared.model.id,
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image', attachment: ref },
        ],
      })],
    })) chunks.push(chunk)
    return { ref, chunks, requested }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('attached image request preparation', () => {
  it('resolves a request version instead of failing the store contract', async () => {
    const { requested, chunks } = await runAttachedImageRequest(solidPng(4096, 4096))
    // The older contract threw at the store's first statement, so nothing was resolved.
    expect(requested).toHaveLength(1)
    const version = requested[0]!
    expect(version.width).toBeGreaterThan(0)
    expect(version.height).toBeGreaterThan(0)
    expect(version.bytes).toBeGreaterThan(0)
    expect(version.bytes).toBeLessThanOrEqual(OPENAI_CODEX_REQUEST_IMAGE_MAX_BYTES)
    for (const failure of chunks.filter(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error')) {
      expect(JSON.stringify(failure)).not.toContain('must be a positive integer')
    }
  })

  it('bounds the request version by the route pixel budget', async () => {
    const { requested } = await runAttachedImageRequest(solidPng(4096, 4096))
    const version = requested[0]!
    expect(version.width * version.height).toBeLessThanOrEqual(2048 * 2048)
  })
})
