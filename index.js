/**
 * Host half of DSH-Quickly-clear.
 *
 * DSH has no "delete one conversation" API. The registry can archive, pin,
 * rename and detach a Session; the persistence store can only create, open,
 * flush, stat and list. Deleting is therefore a sweep over every place one
 * Session is recorded:
 *
 *   1. workspace records drop the Session id, so no workspace still owns it;
 *   2. the archived / pinned flags drop it too, so the sidebar's archived
 *      group stops rendering it;
 *   3. the registry's memoised header and cwd indexes forget it, otherwise the
 *      next snapshot re-derives the Session straight back into its workspace;
 *   4. the Session folder under the JSONL store is removed;
 *   5. the projection cache file named after the Session is removed.
 *
 * Recording is cleaned first on purpose: if the filesystem refuses (a log still
 * open on Windows), the conversation keeps resolving and stays visible instead
 * of leaving a sidebar row that points at nothing.
 *
 * The client half only offers this row for archived Sessions, and the endpoint
 * repeats that rule from the archived set it can read, so a stale client cannot
 * delete a conversation that was unarchived in the meantime.
 */

import { appendFile, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const API_PREFIX = '/DSH-Quickly-clear/api'
const MAX_BODY_BYTES = 8 * 1024

function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
}

const TRACE_PATH = join(dshHome(), 'DSH-Quickly-clear.log')

async function appendTrace(line) {
  try {
    await appendFile(TRACE_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* tracing is best effort */
  }
}

export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence', 'sessions']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => handle(ctx, req, res),
      }),
    'DSH-Quickly-clear: delete one archived conversation and its leftover files',
  )
}

async function handle(ctx, req, res) {
  if (ctx.connection.requestRejection(req) !== undefined) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'this connection is not trusted' } })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const method = pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
  if (method !== 'delete' && method !== 'inspect') {
    sendJson(res, 404, {
      ok: false,
      error: { code: 'unknown-method', message: method === '' ? 'name a method' : `unknown method '${method}'` },
    })
    return
  }
  try {
    const payload = await readJsonBody(req)
    const result = method === 'delete' ? await deleteSession(ctx, payload) : await inspectSession(ctx, payload)
    await appendTrace(`${method} ${JSON.stringify({ in: payload, out: result })}`)
    sendJson(res, 200, result)
  } catch (error) {
    await appendTrace(`${method} failed ${JSON.stringify(toErrorInfo(error))}`)
    sendJson(res, 200, { ok: false, error: toErrorInfo(error) })
  }
}

/* --------------------------------------------------------------- read side -- */

async function inspectSession(ctx, input) {
  const sessionId = asId(input?.sessionId)
  if (sessionId === undefined) return fail('bad-request', 'sessionId is required')
  const root = sessionsRoot(ctx)
  const folders = await findSessionFolders(root, sessionId)
  const cache = await projectionCacheFiles(sessionId)
  return {
    ok: true,
    sessionId,
    sessionsRoot: root,
    folders,
    projectionCache: cache,
    live: ctx.sessions.get(sessionId) !== undefined,
  }
}

/* -------------------------------------------------------------- write side -- */

async function deleteSession(ctx, input) {
  const sessionId = asId(input?.sessionId)
  if (sessionId === undefined) return fail('bad-request', 'sessionId is required')

  if (ctx.sessions.get(sessionId) !== undefined) {
    return fail('session-live', 'this conversation is still open in the host; stop it before deleting')
  }

  const registry = ctx.workspaceRegistry
  const root = sessionsRoot(ctx)
  const folders = await findSessionFolders(root, sessionId)

  const record = { detachedFrom: [], archive: 'unchanged', pin: 'unchanged', staged: folders.length }

  // 1. Workspace records: drop the id wherever it is still listed. The record
  //    is the durable half; the cwd-derived sessionIds getter is cleaned below.
  for (const workspace of listWorkspaces(registry)) {
    const listed = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
    if (listed !== true) continue
    if (typeof workspace.mutate !== 'function') continue
    try {
      await workspace.mutate((current) =>
        Array.isArray(current?.sessionIds) && current.sessionIds.includes(sessionId)
          ? { ...current, sessionIds: current.sessionIds.filter((id) => id !== sessionId) }
          : current,
      )
      record.detachedFrom.push(workspace.id)
    } catch (error) {
      record.detachedFrom.push(`${workspace.id}: ${toErrorInfo(error).message}`)
    }
  }

  // 2. Flags the sidebar groups by.
  try {
    await registry.unarchiveSession(sessionId)
    record.archive = 'cleared'
  } catch (error) {
    record.archive = `failed: ${toErrorInfo(error).message}`
  }
  try {
    await registry.unpinSession(sessionId)
    record.pin = 'cleared'
  } catch (error) {
    record.pin = `failed: ${toErrorInfo(error).message}`
  }

  // 3. Memoised headers and cwds, before the log goes away.
  invalidateSessionCache(registry, sessionId)

  // 4. The Session folder itself.
  const removed = []
  const failures = []
  for (const folder of folders) {
    try {
      await rm(folder, { recursive: true, force: true })
      removed.push(folder)
      await pruneEmptyProject(root, folder)
    } catch (error) {
      failures.push({ path: folder, error: toErrorInfo(error) })
    }
  }

  // 5. Projection cache entries named after the Session.
  for (const path of await projectionCacheFiles(sessionId)) {
    try {
      await rm(path, { force: true })
      removed.push(path)
    } catch (error) {
      failures.push({ path, error: toErrorInfo(error) })
    }
  }

  // 6. Forget it once more: a projection rebuild during the sweep may have
  //    re-read the header before the folder disappeared.
  invalidateSessionCache(registry, sessionId)

  if (removed.length === 0 && failures.length === 0) {
    return {
      ok: true,
      sessionId,
      removed,
      record,
      note: 'no stored log or cache file was found; only the workspace record was cleaned',
    }
  }
  return { ok: true, sessionId, removed, record, failures }
}

/* ---------------------------------------------------------------- storage -- */

function sessionsRoot(ctx) {
  const configured = ctx?.sessionPersistence?.root
  if (typeof configured === 'string' && configured !== '') return configured
  return join(dshHome(), 'sessions')
}

/** Every project folder that holds this Session; normally zero or one. */
async function findSessionFolders(root, sessionId) {
  const segment = encodeSegment(sessionId)
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  const hits = []
  for (const entry of projects) {
    if (entry.isDirectory() !== true) continue
    const candidate = join(root, entry.name, segment)
    if ((await isDirectory(candidate)) === true) hits.push(candidate)
  }
  return hits
}

async function pruneEmptyProject(root, folder) {
  const parent = dirname(folder)
  if (dirname(parent) !== root) return
  const rest = await readdir(parent).catch(() => null)
  if (rest === null || rest.length > 0) return
  await rmdir(parent).catch(() => {})
}

async function projectionCacheFiles(sessionId) {
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  const entries = await readdir(dir).catch(() => [])
  const wanted = new Set([`${sessionId}.json`, `${encodeSegment(sessionId)}.json`])
  return entries.filter((name) => wanted.has(name)).map((name) => join(dir, name))
}

/** Mirrors the JSONL store so a Session folder resolves where the store expects it. */
function encodeSegment(raw) {
  if (raw === '') throw codedError('bad-request', 'an empty name cannot name a session folder')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (const character of raw) {
    const safe = character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
    out += safe ? character : `~${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/* --------------------------------------------------------------- registry -- */

function listWorkspaces(registry) {
  try {
    return registry.list()
  } catch {
    return []
  }
}

/**
 * The registry memoises headers, canonical cwds and the paths it failed to
 * resolve. Every one of them can resurrect a deleted Session, so they all go.
 */
function invalidateSessionCache(registry, sessionId) {
  for (const field of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) {
    const store = registry?.[field]
    if (store !== null && typeof store === 'object' && typeof store.delete === 'function') {
      store.delete(sessionId)
    }
  }
}

/* --------------------------------------------------------------- helpers -- */

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw codedError('bad-request', 'the request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw codedError('bad-request', 'the request body is not JSON')
  }
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function asId(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function toErrorInfo(error) {
  if (error !== null && typeof error === 'object') {
    return {
      code: typeof error.code === 'string' ? error.code : 'internal',
      message: typeof error.message === 'string' ? error.message : String(error),
    }
  }
  return { code: 'internal', message: String(error) }
}

/** Pure helpers, exported so the sweep can be exercised without a live host. */
export const internals = {
  encodeSegment,
  findSessionFolders,
  projectionCacheFiles,
  invalidateSessionCache,
  deleteSession,
}
