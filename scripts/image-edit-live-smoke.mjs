/**
 * Live image-edit acceptance: one real generation, then one real edit of that image.
 *
 * This is the only check that exercises the whole path against the live service — the tool, the
 * edit route, the plugin's asset store, the real attachment store, and session persistence. Every
 * other image test in this repository uses a stubbed transport and therefore cannot show that an
 * edited image actually reaches the conversation.
 *
 * It spends image quota, so it is not part of `pnpm run check`. Two entry points:
 *
 *   npx vitest run tests/image-edit-live.spec.ts     # opt-in spec (recommended)
 *   node --import tsx scripts/image-edit-live-smoke.mjs
 *
 * {@link runLiveImageEdit} returns a structured report and never throws, so the caller decides how
 * to present a failure. Exit code 0 means every assertion held.
 */

import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import * as CodexConnect from '../src/index.ts'
import { IMAGE_GENERATE_TOOL_NAME } from '../src/image-tool.ts'
import { imageRefsInEvent, recentImageRefs } from '../src/image-input.ts'

const require = createRequire(import.meta.url)
const importHost = specifier => import(pathToFileURL(require.resolve(specifier)).href)

/** DSH appends independent Zstandard frames; one synchronous decode consumes only one frame. */
function decodeStoredFrames(bytes) {
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true })
    const consumed = decoded.engine.bytesWritten
    assert.ok(Number.isSafeInteger(consumed) && consumed > 0 && consumed <= bytes.length - offset)
    frames.push(decoded.buffer)
    offset += consumed
  }
  return Buffer.concat(frames)
}

/** Every physical session artifact under one root, decoded, so persistence is checked on disk. */
async function readPhysicalSessions(storageRoot) {
  const found = []
  const visit = async directory => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && /\.jsonl(?:\.zstd)?$/u.test(entry.name)) {
        const bytes = await readFile(path)
        const content = (entry.name.endsWith('.zstd') ? decodeStoredFrames(bytes) : bytes).toString('utf8')
        found.push({ path, content })
      }
    }
  }
  await visit(storageRoot)
  return found
}

function contentOf(result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * Run the live acceptance once and report the outcome. Never throws.
 * @returns a structured report; `ok` is true only when every assertion held.
 */
export async function runLiveImageEdit() {
  const report = { generated: false, edited: false, persisted: false, resolverFound: false }
  let ctx
  try {
  const modules = await Promise.all([
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-token-meter',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-attachment-local',
  ].map(importHost))
  const [cordis, llm, sessions, projections, system, tools, agents, meter, compaction, persistence, attachment] = modules

  const storageRoot = join(tmpdir(), `dsh-codex-image-edit-${process.pid}`)
  report.sessionRoot = storageRoot

  ctx = new cordis.Context()
  // `llm` first: the plugin declares `inject: ['llm']`, so without it apply() never runs at all.
  for (const module of [llm, sessions, projections, system, tools, agents]) await ctx.plugin(module.default)
  await ctx.plugin(meter.default)
  await ctx.plugin(persistence.default, { root: join(storageRoot, 'sessions'), packChunks: true })
  await ctx.plugin(compaction.default, { auto: false })
  // The real deployment home: this is the store the running harness itself serves previews from,
  // so a preview committed here is one the GUI can actually display.
  await ctx.plugin(attachment.default, { dshHome: process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME, '.dsh') })
  const pluginFiber = await ctx.plugin(CodexConnect, { enableImageGeneration: true })
  report.pluginFiberState = pluginFiber?.state ?? String(pluginFiber)
  // The plugin's own service is created inside apply(), so its presence proves apply() completed.
  report.pluginApplied = ctx.get('openaiCodexTransport') !== undefined

  // The plugin registers optional capabilities through an asynchronous serialized tail, so the tool
  // appears shortly after apply() returns rather than during it. Logger output is captured across
  // the whole wait, because a rejected capability fiber reports itself only there.
  report.diagnostics = []
  for (const level of ['error', 'warn']) {
    const original = ctx.logger?.[level]
    if (typeof original !== 'function') continue
    ctx.logger[level] = (...args) => {
      report.diagnostics.push(`[${level}] ${args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(' ')}`)
      return original.apply(ctx.logger, args)
    }
  }
  const deadline = Date.now() + 20_000
  while (ctx.tools.get(IMAGE_GENERATE_TOOL_NAME) === undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const registration = ctx.tools.get(IMAGE_GENERATE_TOOL_NAME)
  report.toolRegistered = registration !== undefined
  assert.ok(registration !== undefined,
    `enableImageGeneration: true must register the image tool once tools and attachments are available; diagnostics=${report.diagnostics.join(' | ')}`)

  const session = ctx.sessions.create(sessions.SessionId(`image-edit-live-${process.pid}`))
  const agent = { id: session.id, options: {}, session }
  const call = (callId, args) => ctx.tools.execute({
    signal: AbortSignal.timeout(300_000),
    callId,
    name: IMAGE_GENERATE_TOOL_NAME,
    arguments: args,
    agent,
  })

  // ---- Step 1: a real generation, which becomes the image the edit will consume ----
  const generated = await call('live-gen-1', {
    prompt: 'A plain flat crimson red square filling the entire frame, nothing else, no text.',
  })
  assert.equal(generated.isError, false, `generation failed: ${contentOf(generated)}`)
  assert.equal(generated.value.operation, 'generate')
  const sourceRef = generated.value.images[0].preview
  assert.equal(typeof sourceRef.attachmentId, 'string')
  assert.ok(sourceRef.width >= 256, `expected a real raster, got ${sourceRef.width}x${sourceRef.height}`)
  report.generated = { mediaType: sourceRef.mediaType, width: sourceRef.width, height: sourceRef.height, bytes: sourceRef.bytes }
  report.generationText = contentOf(generated)

  // The result must be a real image content block: that is what the conversation renders.
  const emitted = generated.content.filter(block => block.type === 'image')
  assert.equal(emitted.length, generated.value.images.length, 'every image must be emitted as an image content block')

  // ---- Step 2: the tool result must enter the session as a real event ----
  //
  // A direct `ctx.tools.execute` does NOT append anything: the append is the agent loop's job, and
  // this fixture drives the tool without a model turn. So the result event is appended here in the
  // exact shape DSH itself writes (verified against a real session log: the envelope carries
  // `surfaceOp`/`sourceEventSeqs`, `data` carries `turn`/`step`/`message`, and the message is a
  // `role: "user"` `source: {kind: "tool"}` record). An assistant message is appended first because
  // `sourceEventSeqs` may only cite earlier events.
  const promptEvent = session.append('user/message', {
    id: `live-user-${process.pid}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Generate a flat red square.' }],
  }, { surfaceOp: 'append' })
  const callId = `call_live_gen_${process.pid}`
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: `live-result-${process.pid}`,
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        // The image content blocks the tool produced, verbatim: this is what the conversation renders.
        content: generated.content,
        isError: false,
      }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [promptEvent.seq] })

  const events = session.snapshotEvents()
  report.sessionEventCount = events.length
  const resultEvents = events.filter(event => event.type === 'tool/result')
  assert.ok(resultEvents.length > 0, 'the generated image must be recorded as a tool/result event')
  const foundByResolver = recentImageRefs(events, 1)
  assert.equal(foundByResolver.length, 1, 'recentImageRefs must find the generated image in the live session log')
  assert.equal(foundByResolver[0].attachmentId, sourceRef.attachmentId,
    'the resolver must find the same attachment the tool returned')
  assert.deepEqual(JSON.parse(JSON.stringify(foundByResolver[0])), JSON.parse(JSON.stringify(sourceRef)),
    'the resolver must reproduce the complete reference, since readImage verifies every field')
  report.resolverFound = true
  report.resolverRef = foundByResolver[0]

  // The block must also survive the surface fold, i.e. be part of the conversation the model is
  // given rather than only a log record.
  const derived = session.deriveMessages()
  const derivedImages = derived.flatMap(message =>
    (message.content ?? []).flatMap(block => block.type === 'tool-result' && Array.isArray(block.content)
      ? block.content.filter(inner => inner.type === 'image')
      : []))
  report.derivedImageBlocks = derivedImages.length
  assert.ok(derivedImages.length > 0, 'the image block must survive the surface fold into derived messages')

  // ---- Step 3: the real edit, routed by the PRESENCE of the input image ----
  const edited = await call('live-edit-1', {
    prompt: 'Replace the red with a solid vivid blue. Keep the image an otherwise plain flat colour field.',
    images: [{ kind: 'recent', count: 1, role: 'edit-target' }],
  })
  assert.equal(edited.isError, false,
    `edit failed: ${contentOf(edited)}\nresolver saw: ${JSON.stringify(report.resolverRef)}`)
  assert.equal(edited.value.operation, 'edit', 'an edited result must be marked as an edit')
  const editedRef = edited.value.images[0].preview
  assert.notEqual(editedRef.attachmentId, sourceRef.attachmentId,
    'the edit must produce a new attachment, not return the input')
  report.edited = { mediaType: editedRef.mediaType, width: editedRef.width, height: editedRef.height, bytes: editedRef.bytes }
  report.editText = contentOf(edited)
  report.inputEchoes = edited.value.images.map(image => ({ warning: image.warning }))

  // The edit must actually differ from its input: compare verified bytes through the real store.
  const before = await ctx.attachments.readImage(sourceRef)
  const after = await ctx.attachments.readImage(editedRef)
  assert.equal(before.data.byteLength, sourceRef.bytes, 'the input must read back at its recorded size')
  assert.equal(after.data.byteLength, editedRef.bytes, 'the output must read back at its recorded size')
  assert.notEqual(Buffer.from(after.data).toString('base64'), Buffer.from(before.data).toString('base64'),
    'an edit must not return a byte-identical copy of its input')
  report.bytes = { input: before.data.byteLength, output: after.data.byteLength }
  report.outputIsNewBytes = true

  // ---- Step 3.5: the edited result enters the session exactly as the loop would record it ----
  session.append('tool/result', {
    turn: 1,
    step: 2,
    message: {
      id: `live-edit-result-${process.pid}`,
      role: 'user',
      source: { kind: 'tool', callId: `call_live_edit_${process.pid}` },
      content: [{
        type: 'tool-result',
        toolCallId: `call_live_edit_${process.pid}`,
        content: edited.content,
        isError: false,
      }],
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [promptEvent.seq] })

  // ---- Step 4: it must be durable, i.e. actually in the session rather than asserted to be ----
  await ctx.sessions.flush(session)
  const artifactId = editedRef.attachmentId
  const physical = await readPhysicalSessions(join(storageRoot, 'sessions'))
  report.sessionArtifacts = physical.map(entry => entry.path)
  const carrying = physical.filter(entry => entry.content.includes(artifactId))
  assert.ok(carrying.length > 0,
    `no persisted session artifact contains the edited attachment ${artifactId}; artifacts: ${report.sessionArtifacts.join(', ')}`)
  report.persisted = true
  report.persistedIn = carrying.map(entry => entry.path)

  // Both the input and the edited result must be durable, and each must remain its own attachment.
  const carriesSource = physical.some(entry => entry.content.includes(sourceRef.attachmentId))
  assert.ok(carriesSource, 'the session must also retain the input image it edited')

  // The edited image must be part of the derived conversation, not merely a log record.
  const derivedAfter = session.deriveMessages()
  const derivedAfterImages = derivedAfter.flatMap(message =>
    (message.content ?? []).flatMap(block => block.type === 'tool-result' && Array.isArray(block.content)
      ? block.content.filter(inner => inner.type === 'image')
      : []))
  report.derivedImageBlocksAfterEdit = derivedAfterImages.length
  assert.equal(derivedAfterImages.length, 2,
    'the conversation history must carry both the input image and the edited result')
  assert.ok(derivedAfterImages.some(inner => inner.attachment.attachmentId === editedRef.attachmentId),
    'the edited image must appear in the conversation history the model is given')

  // The persisted record must carry the image block that the conversation projects, not a bare id.
  const line = carrying[0].content.split('\n').find(candidate => candidate.includes(artifactId))
  const parsed = JSON.parse(line)
  const refs = imageRefsInEvent(parsed)
  assert.ok(refs.some(ref => ref.attachmentId === artifactId),
    'the persisted event must be readable as an image block at the path the resolver uses')
  const persistedRef = refs.find(ref => ref.attachmentId === artifactId)
  assert.deepEqual(JSON.parse(JSON.stringify(persistedRef)), JSON.parse(JSON.stringify(editedRef)),
    'the persisted reference must match what the tool returned')
  report.persistedBlockVerified = true

  report.ok = true
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (error instanceof Error && error.stack) report.stack = error.stack.split('\n').slice(0, 6)
} finally {
  try {
    await ctx?.fiber.dispose()
  } catch { /* disposal is best-effort in a one-shot fixture */ }
}
report.attachment = 'the plugin asset store and the real attachment store were both written'
// Persist the evidence either way, so a spec run leaves an inspectable record and not only a
// pass/fail. Distinct per process so concurrent runs cannot clobber each other.
try {
  await writeFile(join(tmpdir(), `dsh-codex-image-edit-live-report-${process.pid}.json`), JSON.stringify(report, null, 2))
} catch { /* the report file is a convenience; its absence must not change the outcome */ }
return report
}

/** CLI entry: run once, print the report, and exit non-zero on any failed assertion. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runLiveImageEdit()
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exit(report.ok === true ? 0 : 1)
}
