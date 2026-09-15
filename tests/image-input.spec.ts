/**
 * Image-reference extraction from session events.
 *
 * These paths are the load-bearing part of image input: if the resolver cannot see a record, the
 * image silently does not exist as far as the tool is concerned. Both shapes asserted here were
 * taken from live sessions rather than inferred:
 *
 *   - `tool/result` at `data.message.content[].content[]` — images a tool produced;
 *   - `user/message` at `data.content[]` — images the person attached.
 *
 * The second shape was originally missed. Reading only the first made the resolver look correct
 * while ignoring every user-supplied image, so it is covered explicitly.
 */

import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { imageRefFromBlock, imageRefsInEvent, recentImageRefs } from '../src/image-input.ts'

function ref(id: string, overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 1024,
    width: 8,
    height: 8,
    name: `${id}.png`,
    ...overrides,
  }
}

/** A tool result, exactly as a real session records one. */
function toolResult(refs: readonly ImageAttachmentRef[]): unknown {
  return {
    type: 'tool/result',
    seq: 10,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'result-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call_1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          content: [
            { type: 'text', text: 'Generated 1 image' },
            ...refs.map(item => ({ type: 'image', attachment: { ...item } })),
          ],
          isError: false,
        }],
      },
    },
  }
}

/** A user turn carrying an attached image, exactly as a real session records one. */
function userMessageWithImage(refs: readonly ImageAttachmentRef[]): unknown {
  return {
    type: 'user/message',
    seq: 20,
    surfaceOp: 'append',
    data: {
      id: 'user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [
        ...refs.map(item => ({ type: 'image', attachment: { ...item } })),
        { type: 'text', text: 'please recolour this' },
      ],
    },
  }
}

describe('imageRefFromBlock', () => {
  it('rebuilds a complete reference from a stored image block', () => {
    const stored = ref('sha256:a')
    expect(imageRefFromBlock({ type: 'image', attachment: { ...stored } })).toEqual(stored)
  })

  it('rejects a block missing a required field rather than passing a partial reference on', () => {
    const stored = ref('sha256:a')
    const { bytes: _omitted, ...withoutBytes } = stored
    expect(imageRefFromBlock({ type: 'image', attachment: withoutBytes })).toBeUndefined()
  })

  it('rejects a non-image block', () => {
    expect(imageRefFromBlock({ type: 'text', text: 'hello' })).toBeUndefined()
  })

  it('rejects a media type the edit route cannot accept', () => {
    const stored = ref('sha256:a', { mediaType: 'image/tiff' as ImageAttachmentRef['mediaType'] })
    expect(imageRefFromBlock({ type: 'image', attachment: { ...stored } })).toBeUndefined()
  })

  it('accepts a reference without a name', () => {
    const { name: _dropped, ...unnamed } = ref('sha256:a')
    expect(imageRefFromBlock({ type: 'image', attachment: unnamed })).toEqual(unnamed)
  })
})

describe('imageRefsInEvent', () => {
  it('reads images a tool produced', () => {
    const stored = ref('sha256:tool')
    expect(imageRefsInEvent(toolResult([stored]))).toEqual([stored])
  })

  it('reads an image the user attached', () => {
    const stored = ref('sha256:user')
    // The regression this guards: a user-supplied image lives on its own event type and path.
    expect(imageRefsInEvent(userMessageWithImage([stored]))).toEqual([stored])
  })

  it('preserves order within one event', () => {
    const first = ref('sha256:first')
    const second = ref('sha256:second')
    expect(imageRefsInEvent(userMessageWithImage([first, second]))).toEqual([first, second])
  })

  it('returns nothing for an event type that carries no images', () => {
    expect(imageRefsInEvent({ type: 'turn/start', data: { turn: 1 } })).toEqual([])
  })

  it('does not mistake an unrelated object for an image block', () => {
    // A text-only user message whose text happens to mention an attachment must yield nothing.
    const event = {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '{"type":"image","attachment":{}}' }] },
    }
    expect(imageRefsInEvent(event)).toEqual([])
  })

  it('ignores a malformed image block inside an otherwise valid message', () => {
    const good = ref('sha256:good')
    const event = {
      type: 'user/message',
      data: {
        content: [
          { type: 'image', attachment: { attachmentId: 'sha256:bad' } },
          { type: 'image', attachment: { ...good } },
        ],
      },
    }
    expect(imageRefsInEvent(event)).toEqual([good])
  })
})

describe('recentImageRefs', () => {
  it('finds an attached image even when no tool has produced one', () => {
    const attached = ref('sha256:attached')
    // This is the exact original complaint: attach an image, ask for an edit. With only the
    // tool-result path, this returned nothing.
    expect(recentImageRefs([userMessageWithImage([attached])], 1)).toEqual([attached])
  })

  it('prefers the newest image across mixed event types', () => {
    const older = ref('sha256:older')
    const newer = ref('sha256:newer')
    const events = [toolResult([older]), userMessageWithImage([newer])]
    expect(recentImageRefs(events, 1)).toEqual([newer])
  })

  it('returns the last image of a multi-image result first', () => {
    const first = ref('sha256:first')
    const second = ref('sha256:second')
    expect(recentImageRefs([userMessageWithImage([first, second])], 1)).toEqual([second])
  })

  it('returns fewer than requested rather than inventing images', () => {
    const only = ref('sha256:only')
    expect(recentImageRefs([userMessageWithImage([only])], 3)).toEqual([only])
  })

  it('rejects a nonsensical count', () => {
    expect(recentImageRefs([userMessageWithImage([ref('sha256:a')])], 0)).toEqual([])
  })
})
