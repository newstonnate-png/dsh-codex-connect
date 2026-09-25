/** Fixed, bounded OAuth transport shared with optional Codex image capabilities. */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { readOpenAICodexRequestAuth } from './auth.ts'
import {
  OPENAI_CODEX_REAUTH_REQUIRED_CODE,
} from './auth-error.ts'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import type { OpenAICodexProxyManager } from './provider-proxy.ts'
import type { OpenAICodexBackendRequests } from './backend-request.ts'
import { prepareOpenAICodexBackendHeaders } from './backend-request-policy.ts'
import { readRetryAfterMs } from './request-backoff.ts'
import { DEFAULT_OPENAI_CODEX_IMAGE_MODEL_HINT, parseOpenAICodexImageModelHint } from './settings-contract.ts'

/** Cordis service name owned by the core plugin fiber. */
export const OPENAI_CODEX_TRANSPORT_SERVICE = 'openaiCodexTransport'

/** Structured contract version used across the core and companion packages. */
export const OPENAI_CODEX_TRANSPORT_API_VERSION = 1 as const

/** Stage-zero verified image-generation endpoint. */
export const OPENAI_CODEX_IMAGE_GENERATION_URL = 'https://chatgpt.com/backend-api/codex/images/generations'

/**
 * Image-edit endpoint. This is the ONLY route that reads an `images` field.
 *
 * `/generations` accepts an `images` field without error and then ignores it entirely: it returned
 * 200 for a request carrying an undecodable image and for one naming a nonexistent `file_id`.
 * Sending input images there therefore yields a plausible image that ignored every input, which is
 * worse than an error, so requests carrying images must never be routed to the generation URL.
 */
export const OPENAI_CODEX_IMAGE_EDITS_URL = 'https://chatgpt.com/backend-api/codex/images/edits'

/** Maximum number of input images accepted in one edit request by host policy. */
export const OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT = 20

/** Local byte ceiling applied to the assembled edit request body before any network work. */
export const OPENAI_CODEX_IMAGE_MAX_REQUEST_BYTES = 192 * 1024 * 1024

/** Network deadline covering the request and bounded response read. */
export const OPENAI_CODEX_IMAGE_REQUEST_TIMEOUT_MS = 120_000

/** Maximum accepted success-body size: 48 MiB. */
export const OPENAI_CODEX_IMAGE_MAX_RESPONSE_BYTES = 48 * 1024 * 1024

/** Maximum error-body size read and discarded: 64 KiB. */
export const OPENAI_CODEX_IMAGE_MAX_ERROR_BYTES = 64 * 1024

/** Defensive upper bound for unexpected multi-image responses. */
export const OPENAI_CODEX_IMAGE_MAX_COUNT = 4

/** Local prompt limit enforced before any credential or network work. */
export const OPENAI_CODEX_IMAGE_PROMPT_MAX_LENGTH = 32_000

/** Internal, unverified route hint. It is intentionally not exported. */
const IMAGE_ROUTE_HINT_MODEL = 'gpt-image-2'

/** Stable, secret-free transport errors consumed structurally by companion packages. */
export const OPENAI_CODEX_TRANSPORT_ERROR_CODES = {
  invalidRequest: 'OPENAI_CODEX_INVALID_REQUEST',
  signedOut: 'OPENAI_CODEX_SIGNED_OUT',
  reauthRequired: OPENAI_CODEX_REAUTH_REQUIRED_CODE,
  rateLimited: 'OPENAI_CODEX_RATE_LIMITED',
  upstreamRejected: 'OPENAI_CODEX_UPSTREAM_REJECTED',
  upstreamUnavailable: 'OPENAI_CODEX_UPSTREAM_UNAVAILABLE',
  redirectRejected: 'OPENAI_CODEX_REDIRECT_REJECTED',
  timeout: 'OPENAI_CODEX_TIMEOUT',
  canceled: 'OPENAI_CODEX_CANCELED',
  networkError: 'OPENAI_CODEX_NETWORK_ERROR',
  responseTooLarge: 'OPENAI_CODEX_RESPONSE_TOO_LARGE',
  malformedResponse: 'OPENAI_CODEX_MALFORMED_RESPONSE',
} as const

/** Union of the stable transport error codes. */
export type OpenAICodexTransportErrorCode =
  (typeof OPENAI_CODEX_TRANSPORT_ERROR_CODES)[keyof typeof OPENAI_CODEX_TRANSPORT_ERROR_CODES]

const TRANSPORT_ERROR_CODES = new Set<string>(Object.values(OPENAI_CODEX_TRANSPORT_ERROR_CODES))

const ERROR_MESSAGES: Record<OpenAICodexTransportErrorCode, string> = {
  OPENAI_CODEX_INVALID_REQUEST: 'The Codex image request is invalid',
  OPENAI_CODEX_SIGNED_OUT: 'OpenAI Codex is signed out',
  OPENAI_CODEX_REAUTH_REQUIRED: 'OpenAI Codex authorization must be renewed',
  OPENAI_CODEX_RATE_LIMITED: 'The Codex image endpoint is rate limited',
  OPENAI_CODEX_UPSTREAM_REJECTED: 'The Codex image endpoint rejected the request',
  OPENAI_CODEX_UPSTREAM_UNAVAILABLE: 'The Codex image endpoint is unavailable',
  OPENAI_CODEX_REDIRECT_REJECTED: 'The Codex image endpoint returned a redirect',
  OPENAI_CODEX_TIMEOUT: 'The Codex image request timed out and may still be processing',
  OPENAI_CODEX_CANCELED: 'The Codex image request was canceled and may still be processing',
  OPENAI_CODEX_NETWORK_ERROR: 'The Codex image request failed before a response was received',
  OPENAI_CODEX_RESPONSE_TOO_LARGE: 'The Codex image response exceeded the safe size limit',
  OPENAI_CODEX_MALFORMED_RESPONSE: 'The Codex image endpoint returned an unreadable response',
}

/** Fixed, secret-free transport failure. */
export class OpenAICodexTransportError extends Error {
  readonly code: OpenAICodexTransportErrorCode
  readonly status?: number
  readonly retryAfterSeconds?: number

  constructor(
    code: OpenAICodexTransportErrorCode,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(ERROR_MESSAGES[code])
    this.name = 'OpenAICodexTransportError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds
  }
}

/** Identify transport failures structurally without relying on cross-package class identity. */
export function isOpenAICodexTransportError(error: unknown): error is OpenAICodexTransportError {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const code = (error as Record<string, unknown>)['code']
  return typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code)
}

/** Only caller-controlled field accepted by the Host transport. */
export interface ImageGenerationRequest {
  readonly prompt: string
}

/** One already-validated input image, encoded for the wire by the caller. */
export interface ImageEditInput {
  /** Canonical base64 of the exact bytes to submit. */
  readonly b64: string
  /** Declared media type; the route validates the raster itself. */
  readonly mediaType: string
}

/** Edit request: a prompt plus at least one input image. */
export interface ImageEditRequest {
  readonly prompt: string
  readonly images: readonly ImageEditInput[]
}

/** Request lifecycle supplied by the Host tool in PR-3. */
export interface ImageRequestContext {
  readonly signal?: AbortSignal | undefined
}

/** One encoded image awaiting PR-3 signature and attachment validation. */
export interface GeneratedImagePayload {
  readonly b64Json: string
}

/** Bounded, structured success projection returned to the companion package. */
export interface ImageGenerationResponse {
  readonly apiVersion: 1
  readonly traceId: string
  readonly elapsedMs: number
  readonly responseBytes: number
  readonly images: readonly GeneratedImagePayload[]
  /** Which route produced this result. */
  readonly operation: 'generate' | 'edit'
  /**
   * Output size as reported by the service, or undefined when absent.
   *
   * The service does NOT validate requested `size`/`quality`; it silently ignores values it does
   * not like. These echoed fields are therefore the only trustworthy record of what was produced,
   * which is why the plugin sends neither and reads them here instead.
   */
  readonly size?: string
  readonly quality?: string
}

/** Versioned Host-only API provided by the core plugin. */
export interface OpenAICodexTransportV1 {
  readonly apiVersion: 1
  generateImages(
    input: ImageGenerationRequest,
    context: ImageRequestContext,
  ): Promise<ImageGenerationResponse>
  editImages(
    input: ImageEditRequest,
    context: ImageRequestContext,
  ): Promise<ImageGenerationResponse>
}

function responseTooLarge(): OpenAICodexTransportError {
  return new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.responseTooLarge)
}

/** Read a response body without ever retaining more than `maxBytes`. */
export async function readOpenAICodexBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer')
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) throw responseTooLarge()
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw responseTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function retryAfterSeconds(response: Response): number | undefined {
  const milliseconds = readRetryAfterMs(response.headers)
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined
  const seconds = Math.ceil(milliseconds / 1_000)
  return Number.isSafeInteger(seconds) ? seconds : undefined
}

function statusError(response: Response): OpenAICodexTransportError {
  const options: { status?: number; retryAfterSeconds?: number } = { status: response.status }
  const retryAfter = response.status === 429 ? retryAfterSeconds(response) : undefined
  if (retryAfter !== undefined) options.retryAfterSeconds = retryAfter
  if (response.type === 'opaqueredirect' || response.status === 0
    || (response.status >= 300 && response.status < 400)) {
    return new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.redirectRejected, options)
  }
  if (response.status === 401 || response.status === 403) {
    return new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.reauthRequired, options)
  }
  if (response.status === 429) {
    return new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.rateLimited, options)
  }
  if (response.status >= 400 && response.status < 500) {
    return new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.upstreamRejected, options)
  }
  return new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.upstreamUnavailable, options)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

interface ParsedSuccess {
  readonly images: readonly GeneratedImagePayload[]
  readonly size?: string
  readonly quality?: string
}

function parseSuccess(bytes: Uint8Array): ParsedSuccess {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.malformedResponse)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.malformedResponse)
  }
  const envelope = value as Record<string, unknown>
  const data = envelope['data']
  if (!Array.isArray(data) || data.length === 0 || data.length > OPENAI_CODEX_IMAGE_MAX_COUNT) {
    throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.malformedResponse)
  }
  const images: GeneratedImagePayload[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.malformedResponse)
    }
    const b64Json = (item as Record<string, unknown>)['b64_json']
    if (typeof b64Json !== 'string' || b64Json.length === 0) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.malformedResponse)
    }
    images.push({ b64Json })
  }
  // Unknown envelope keys are ignored deliberately: the live service returns a superset of the
  // fields the compiled client declares, and rejecting extra keys would break on any addition.
  const size = envelope['size']
  const quality = envelope['quality']
  return {
    images,
    ...(typeof size === 'string' && size.length > 0 ? { size } : {}),
    ...(typeof quality === 'string' && quality.length > 0 ? { quality } : {}),
  }
}

/** Validate an edit request's input list before any credential or network work. */
function assertEditInputs(images: readonly ImageEditInput[] | undefined): readonly ImageEditInput[] {
  if (!Array.isArray(images) || images.length === 0) {
    throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
  }
  if (images.length > OPENAI_CODEX_IMAGE_MAX_INPUT_COUNT) {
    throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
  }
  for (const image of images) {
    if (typeof image?.b64 !== 'string' || image.b64.length === 0) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
    }
    if (typeof image.mediaType !== 'string' || !/^image\/(png|jpeg|webp|gif)$/u.test(image.mediaType)) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
    }
  }
  return images
}

/** Core-owned Cordis service for the optional image package. */
export class OpenAICodexTransport extends Service implements OpenAICodexTransportV1 {
  readonly apiVersion = OPENAI_CODEX_TRANSPORT_API_VERSION

  constructor(
    ctx: Context,
    private readonly credentials: OpenAICodexCredentialStore,
    private readonly proxyManager?: OpenAICodexProxyManager,
    private readonly resolveProxyUrl: () => string | undefined = () => undefined,
    private readonly resolveImageModelHint: () => string = () => DEFAULT_OPENAI_CODEX_IMAGE_MODEL_HINT,
    private readonly backendRequests?: OpenAICodexBackendRequests,
  ) {
    super(ctx, OPENAI_CODEX_TRANSPORT_SERVICE)
  }

  async generateImages(
    input: ImageGenerationRequest,
    context: ImageRequestContext,
  ): Promise<ImageGenerationResponse> {
    if (this.backendRequests !== undefined) {
      try {
        return await this.backendRequests.run(
          { lane: 'image', signal: context.signal, timeoutMs: OPENAI_CODEX_IMAGE_REQUEST_TIMEOUT_MS },
          request => this.request('generate', input.prompt, undefined, { signal: request.signal }, request.fetch),
        )
      } catch (error: unknown) {
        if (isOpenAICodexTransportError(error)) throw error
        if (isAborted(context.signal)) throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.canceled)
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.timeout)
        }
        throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.networkError)
      }
    }
    const operation = () => this.request('generate', input.prompt, undefined, context)
    return this.proxyManager?.run(this.resolveProxyUrl(), operation) ?? operation()
  }

  /**
   * Submit an edit against one or more input images.
   *
   * Always uses the edits route: the generation route ignores an `images` field without error.
   */
  async editImages(
    input: ImageEditRequest,
    context: ImageRequestContext,
  ): Promise<ImageGenerationResponse> {
    const images = assertEditInputs(input?.images)
    if (this.backendRequests !== undefined) {
      try {
        return await this.backendRequests.run(
          { lane: 'image', signal: context.signal, timeoutMs: OPENAI_CODEX_IMAGE_REQUEST_TIMEOUT_MS },
          request => this.request('edit', input.prompt, images, { signal: request.signal }, request.fetch),
        )
      } catch (error: unknown) {
        if (isOpenAICodexTransportError(error)) throw error
        if (isAborted(context.signal)) throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.canceled)
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.timeout)
        }
        throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.networkError)
      }
    }
    const operation = () => this.request('edit', input.prompt, images, context)
    return this.proxyManager?.run(this.resolveProxyUrl(), operation) ?? operation()
  }

  private async request(
    operation: 'generate' | 'edit',
    prompt: unknown,
    images: readonly ImageEditInput[] | undefined,
    context: ImageRequestContext,
    requestFetch: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<ImageGenerationResponse> {
    if (typeof prompt !== 'string' || prompt.trim().length === 0
      || prompt.length > OPENAI_CODEX_IMAGE_PROMPT_MAX_LENGTH) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
    }
    if (isAborted(context.signal)) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.canceled)
    }
    let imageModelHint: string
    try {
      imageModelHint = parseOpenAICodexImageModelHint(this.resolveImageModelHint()) || IMAGE_ROUTE_HINT_MODEL
    } catch {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
    }

    const credentials = await this.credentials.captureActiveAccount()
    const stored = await credentials.read(OPENAI_CODEX_PROVIDER)
    if (stored?.type !== 'oauth') {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.signedOut)
    }

    let auth: Awaited<ReturnType<typeof readOpenAICodexRequestAuth>>
    try {
      auth = await readOpenAICodexRequestAuth(credentials, context.signal)
    } catch {
      if (isAborted(context.signal)) throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.canceled)
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.reauthRequired)
    }
    const access = auth?.access
    const accountId = auth?.accountId
    if (typeof access !== 'string' || access.length === 0
      || typeof accountId !== 'string' || accountId.length === 0) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.reauthRequired)
    }
    if (isAborted(context.signal)) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.canceled)
    }

    // Body shape is confirmed empirically: plural `images`, each element an object carrying
    // exactly one of `image_url` or `file_id`. `file_id` addresses OpenAI-hosted files and is not
    // usable here, so every input travels as a base64 data URI. No size/quality/background is
    // sent: the service silently ignores invalid values for those rather than rejecting them.
    const body = operation === 'edit'
      ? JSON.stringify({
          model: imageModelHint,
          prompt,
          images: (images ?? []).map(image => ({
            image_url: `data:${image.mediaType};base64,${image.b64}`,
          })),
        })
      : JSON.stringify({ model: imageModelHint, prompt })
    if (body.length > OPENAI_CODEX_IMAGE_MAX_REQUEST_BYTES) {
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.invalidRequest)
    }
    const url = operation === 'edit' ? OPENAI_CODEX_IMAGE_EDITS_URL : OPENAI_CODEX_IMAGE_GENERATION_URL

    const traceId = randomUUID()
    const startedAt = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const onCallerAbort = (): void => { controller.abort(context.signal?.reason) }
    context.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (isAborted(context.signal)) controller.abort(context.signal?.reason)
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('Image request deadline exceeded', 'TimeoutError'))
    }, OPENAI_CODEX_IMAGE_REQUEST_TIMEOUT_MS)

    try {
      const { headers } = prepareOpenAICodexBackendHeaders({
        authorization: `Bearer ${access}`,
        'chatgpt-account-id': accountId,
        'content-type': 'application/json',
        accept: 'application/json',
      }, 'plugin')
      const response = await requestFetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers,
        body,
      })
      if (!response.ok) {
        try {
          await readOpenAICodexBoundedBody(response, OPENAI_CODEX_IMAGE_MAX_ERROR_BYTES)
        } catch {
          // Error bodies are deliberately discarded; status remains authoritative.
        }
        throw statusError(response)
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.malformedResponse)
      }
      const bytes = await readOpenAICodexBoundedBody(response, OPENAI_CODEX_IMAGE_MAX_RESPONSE_BYTES)
      const parsed = parseSuccess(bytes)
      return {
        apiVersion: OPENAI_CODEX_TRANSPORT_API_VERSION,
        traceId,
        elapsedMs: Date.now() - startedAt,
        responseBytes: bytes.byteLength,
        images: parsed.images,
        operation,
        ...(parsed.size === undefined ? {} : { size: parsed.size }),
        ...(parsed.quality === undefined ? {} : { quality: parsed.quality }),
      }
    } catch (error: unknown) {
      if (isOpenAICodexTransportError(error)) throw error
      if (isAborted(context.signal)) {
        if (context.signal?.reason instanceof DOMException && context.signal.reason.name === 'TimeoutError') {
          throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.timeout)
        }
        throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.canceled)
      }
      if (timedOut) throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.timeout)
      throw new OpenAICodexTransportError(OPENAI_CODEX_TRANSPORT_ERROR_CODES.networkError)
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}
