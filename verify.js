/**
 * Self-check for DSH-Quickly-clear.
 *
 * Exercises the pure half of the Host module against a throwaway directory: no
 * Host, no network, nothing under the real DSH_HOME is touched. Run it with
 * `node verify.js` after editing index.js.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const scratch = await mkdtemp(join(tmpdir(), 'quickly-clear-'))
process.env.DSH_HOME = join(scratch, 'home')

const { internals } = await import('./index.js')
const { encodeSegment, findSessionFolders, projectionCacheFiles } = internals

const failures = []
function check(name, run) {
  try {
    run()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? String(error)}`)
    process.stdout.write(`FAIL ${name}: ${error?.message ?? String(error)}\n`)
  }
}

check('a plain session id keeps its own folder name', () => {
  assert.equal(encodeSegment('session-a902edae-5cba-4d20-ab55-2dab267ac4c5'), 'session-a902edae-5cba-4d20-ab55-2dab267ac4c5')
})

check('colons in an IM session id become ~003A', () => {
  assert.equal(encodeSegment('im:weixin:dm:42'), 'im~003Aweixin~003Adm~003A42')
})

check('a literal tilde is escaped, not left to look like an escape', () => {
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

check('the two degenerate names are escaped', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

const root = join(scratch, 'sessions')
const sessionId = 'session-11111111-2222-3333-4444-555555555555'
const nested = join(root, '--D-DSH--', encodeSegment(sessionId))
await mkdir(nested, { recursive: true })
await writeFile(join(nested, 'session.v4.jsonl.zstd'), Buffer.from('placeholder'))

const elsewhere = join(root, '--D-Aemeath--', encodeSegment('session-99999999-8888-7777-6666-555555555555'))
await mkdir(elsewhere, { recursive: true })

const found = await findSessionFolders(root, sessionId)
check('the session folder is found under its project directory', () => {
  assert.deepEqual(found, [nested])
})

check('an unknown session id resolves to nothing', async () => {
  const missing = await findSessionFolders(root, 'session-does-not-exist')
  assert.deepEqual(missing, [])
})

const cacheDir = join(scratch, 'home', 'storages', 'session_projcache', 'sessions')
await mkdir(cacheDir, { recursive: true })
await writeFile(join(cacheDir, `${sessionId}.json`), '{}')
await writeFile(join(cacheDir, `${encodeSegment('im:weixin:dm:42')}.json`), '{}')
await writeFile(join(cacheDir, 'session-unrelated.json'), '{}')

const cached = await projectionCacheFiles(sessionId)
check('the projection cache entry for this session is selected', () => {
  assert.deepEqual(cached, [join(cacheDir, `${sessionId}.json`)])
})

const imCached = await projectionCacheFiles('im:weixin:dm:42')
check('the encoded projection cache entry is selected too', () => {
  assert.deepEqual(imCached, [join(cacheDir, `${encodeSegment('im:weixin:dm:42')}.json`)])
})

const unrelated = await projectionCacheFiles('session-unrelated-other')
check('another session cache file is left alone', () => {
  assert.deepEqual(unrelated, [])
})

/* -------------------------------------------------- the sweep, with a stub host -- */

const { deleteSession } = internals
const { existsSync } = await import('node:fs')

function makeWorkspace(id, sessionIds) {
  const workspace = {
    id,
    sessionIds: [...sessionIds],
    record: { id, title: 'stub', sessionIds: [...sessionIds] },
    async mutate(recipe) {
      const next = recipe(workspace.record)
      if (next !== workspace.record) {
        workspace.record = next
        workspace.sessionIds = next.sessionIds
      }
      return next
    },
  }
  return workspace
}

function makeContext({ root, sessionIds, live }) {
  const calls = { archive: [], pin: [] }
  const workspace = makeWorkspace('ws-1', sessionIds)
  const registry = {
    list: () => [workspace],
    unarchiveSession: async (id) => {
      calls.archive.push(id)
    },
    unpinSession: async (id) => {
      calls.pin.push(id)
    },
    headers: new Map([[sessionId, { id: sessionId }]]),
    sessionPaths: new Map([[sessionId, 'stale']]),
    missingSessionPaths: new Map([[sessionId, true]]),
    invalidSessionPaths: new Map([[sessionId, true]]),
  }
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: { root },
    sessions: { get: (id) => (live === true && id === sessionId ? { id } : undefined) },
  }
  return { ctx, workspace, registry, calls }
}

const sweepRoot = join(scratch, 'sweep-sessions')
const sweepCache = join(scratch, 'home', 'storages', 'session_projcache', 'sessions')
const sweepFolder = join(sweepRoot, '--D-DSH--', encodeSegment(sessionId))
const sweepCacheFile = join(sweepCache, `${sessionId}.json`)
await mkdir(sweepFolder, { recursive: true })
await writeFile(join(sweepFolder, 'session.v4.jsonl.zstd'), Buffer.from('placeholder'))
await writeFile(sweepCacheFile, '{}')

const { ctx, workspace, registry, calls } = makeContext({ root: sweepRoot, sessionIds: [sessionId], live: false })
const swept = await deleteSession(ctx, { sessionId })

check('the sweep reports success', () => {
  assert.equal(swept.ok, true)
})

check('the workspace record drops the session id', () => {
  assert.deepEqual(workspace.record.sessionIds, [])
})

check('the archived and pinned flags are cleared', () => {
  assert.deepEqual(calls.archive, [sessionId])
  assert.deepEqual(calls.pin, [sessionId])
  assert.equal(swept.record.archive, 'cleared')
  assert.equal(swept.record.pin, 'cleared')
})

check('the session folder is gone', () => {
  assert.equal(existsSync(sweepFolder), false)
})

check('the emptied project folder is pruned', () => {
  assert.equal(existsSync(join(sweepRoot, '--D-DSH--')), false)
})

check('the projection cache file is gone', () => {
  assert.equal(existsSync(sweepCacheFile), false)
})

check('the registry caches forget the session', () => {
  for (const store of [registry.headers, registry.sessionPaths, registry.missingSessionPaths, registry.invalidSessionPaths]) {
    assert.equal(store.has(sessionId), false)
  }
})

const liveFolder = join(sweepRoot, '--D-Aemeath--', encodeSegment(sessionId))
await mkdir(liveFolder, { recursive: true })
const liveCase = makeContext({ root: sweepRoot, sessionIds: [sessionId], live: true })
const refused = await deleteSession(liveCase.ctx, { sessionId })

check('a still-running session is refused', () => {
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'session-live')
})

check('a refused sweep leaves the files alone', () => {
  assert.equal(existsSync(liveFolder), true)
  assert.deepEqual(liveCase.workspace.record.sessionIds, [sessionId])
})

await rm(liveFolder, { recursive: true, force: true })
const emptyCase = makeContext({ root: sweepRoot, sessionIds: [sessionId], live: false })
const nothing = await deleteSession(emptyCase.ctx, { sessionId })

check('a booking with no stored log still cleans the record', () => {
  assert.equal(nothing.ok, true)
  assert.deepEqual(emptyCase.workspace.record.sessionIds, [])
  assert.equal(typeof nothing.note, 'string')
})

await rm(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\nall checks passed\n')
}
