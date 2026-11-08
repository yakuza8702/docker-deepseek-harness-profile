/**
 * GitHub adapter — api.github.com REST v3.
 *
 * Every method takes an already-resolved token and a `request` function
 * injected by `lib/operations.js`. Nothing here logs, echoes, or persists the
 * token: it appears only in the `authorization` header of the request it
 * belongs to, and `redact`-worthy text never leaves this module unmasked
 * (operations redacts again on the way out).
 *
 * Endpoints follow SOL §5 plus the agent-action extensions: `/user`,
 * `/user/repos`, `/repos/{o}/{r}/…` for pulls, issues, branches, actions runs,
 * the git data API (trees / tags / refs), the contents API, commits, rate limit,
 * labels and assignees.
 *
 * TWO HONEST LIMITS, STATED IN THE RESULT RATHER THAN GUESSED AT
 * --------------------------------------------------------------
 *   * GitHub publishes NO blame API. `blame()` returns
 *     `{ supported: false, reason }` — it never fabricates per-line data.
 *   * `pr_diff()` asks for a diff media type; when the server answers with JSON
 *     anyway (an old GHE build), the difference is reported, not silently
 *     rendered as an empty patch.
 *
 * @module dsh-connector/lib/providers/github
 */

/** The REST surface for one GitHub origin. */
const ACCEPT = 'application/vnd.github+json'
const DIFF_ACCEPT = 'application/vnd.github.diff'
const API_VERSION = '2022-11-28'
const PER_PAGE = 100
const MAX_PAGES = 5
/**
 * How many jobs one run-log read fetches before it says so out loud.
 *
 * A matrix run can have dozens of jobs; reading them all multiplies the exit
 * cost of one list call. The cap is reported in `refused` when it bites, so a
 * short log is never mistaken for a complete one.
 */
const MAX_LOG_JOBS = 10
/** Where public GitHub clones from when nothing better is known. */
const PUBLIC_WEB_ORIGIN = 'https://github.com'
/** A full commit sha — the only ref shape the git data API needs no lookup for. */
const FULL_SHA = /^[0-9a-f]{40}$/iu

/**
 * Encode one ref or file path while KEEPING its slashes.
 *
 * `encodeURIComponent('feature/x')` produces `feature%2Fx`, which GitHub reads as
 * one path segment — a branch called `feature/x` then 404s. Encoding segment by
 * segment keeps the separator real and still encodes spaces, `#`, `?` and the
 * like, so a value can never break out of the path it belongs to.
 *
 * @param value - ref name or repository path.
 * @returns the path-safe form.
 */
const seg = (value) => String(value ?? '').split('/').map(encodeURIComponent).join('/')

/**
 * The web origin a push should clone from, derived from the configured API base.
 *
 * The two hosts differ in a way that matters: public GitHub serves REST at
 * `api.github.com` and git at `github.com`, while GitHub Enterprise serves REST at
 * `https://HOST/api/v3` and git at `https://HOST`. Hardcoding `github.com` sent
 * every GHE push to the public site — at best a 404, at worst a push into an
 * unrelated public repository.
 *
 * @param apiBase - the configured REST origin.
 * @returns the git/web origin, without a trailing slash.
 */
export function webOriginOf(apiBase) {
  const text = String(apiBase ?? '').trim()
  if (text === '') return PUBLIC_WEB_ORIGIN
  let url
  try {
    url = new URL(text)
  } catch {
    return PUBLIC_WEB_ORIGIN
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return PUBLIC_WEB_ORIGIN
  if (url.host === 'api.github.com') return `${url.protocol}//github.com`
  // GHE (self-hosted): the API sits under /api/v3 of the instance itself, and a
  // `api.` prefix is the convention for a separately-named API host.
  const host = url.host.startsWith('api.') ? url.host.slice(4) : url.host
  return `${url.protocol}//${host}`
}

/**
 * Decode a base64 blob, but only when it is text.
 *
 * A binary file decoded as UTF-8 is mojibake that reads like corruption, so a NUL
 * byte in the payload suppresses the text form — `contentBase64` is still there
 * for a caller that wants the bytes.
 *
 * @param base64 - base64 payload from the contents API.
 * @returns the UTF-8 text, or `undefined` for binary/empty payloads.
 */
export function decodeTextBase64(base64) {
  const encoded = String(base64 ?? '').replace(/\s+/gu, '')
  if (encoded === '') return undefined
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length === 0 || buffer.includes(0)) return undefined
  return buffer.toString('utf8')
}

/**
 * Does this payload look like a ZIP archive rather than text?
 *
 * The run-level log route answers with a ZIP of per-job logs on many builds, and
 * the request helper hands back a UTF-8 decode of those bytes — which renders as
 * mojibake that reads like a corrupt log. The local file header (`PK\x03\x04`)
 * is ASCII, so it survives the decode and is a reliable signal that the body
 * must not be shown as text.
 *
 * @param text - the body handed back by the request helper.
 * @returns true when the body starts with a ZIP header.
 */
function looksLikeZip(text) {
  return typeof text === 'string' && (text.startsWith('PK\u0003\u0004') || text.startsWith('PK\u0005\u0006'))
}

/**
 * Build the GitHub adapter.
 * @param options - adapter options.
 * @param options.apiBase - REST origin, e.g. `https://api.github.com`.
 * @param options.request - injected HTTP function from operations.
 * @returns the adapter.
 */
export function createGitHub({ apiBase, request, onUnauthorized }) {
  const base = String(apiBase || 'https://api.github.com').replace(/\/+$/u, '')

  /** One authenticated call. The token rides only this header. */
  const call = (token, path, { method = 'GET', body, accept = ACCEPT } = {}) => request(`${base}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'dsh-connector/0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  /**
   * THE ANONYMOUS CALL. No `authorization` key at all — not an empty one, not a
   * placeholder: the request that leaves this function carries no credential of
   * any kind. It exists solely for PUBLIC READ FALLBACK (see `readRepo`).
   */
  const anonymousCall = (path, { method = 'GET', body, accept = ACCEPT } = {}) => request(`${base}${path}`, {
    method,
    headers: {
      accept,
      'x-github-api-version': API_VERSION,
      'user-agent': 'dsh-connector/0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  /** A path that addresses repository CONTENT (the only shape that may go anonymous). */
  const isRepoPath = (path) => /^\/repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/|$)/u.test(path)

  /**
   * ONE repository READ, with the two-layer fallback the owner specified.
   *
   *   1. authenticated call;
   *   2. on 401/403/404 **for a `/repos/...` read only**: if it was a 401 and a
   *      refresh hook exists, refresh ONCE and retry AUTHENTICATED;
   *   3. then retry the SAME read anonymously (no Authorization header);
   *   4. if the anonymous read also fails, the ORIGINAL typed error is returned.
   *
   * Writes never come through here, and neither do authenticated-only endpoints
   * (`/user`, `/user/*`, secrets): `isRepoPath` is the gate, and the write verbs
   * call `call` directly. `meta` receives `public: true` / `refreshed: true` so
   * the caller can say how a read was served.
   *
   * @param token - the access token for the first attempt.
   * @param path - REST path, starting with `/repos/`.
   * @param options - `{ method, body, accept }`.
   * @param meta - out-parameter; set to `{ public, refreshed }`.
   * @returns the response (original failure when every layer fails).
   */
  async function readRepo(token, path, options = {}, meta = {}) {
    const first = await call(token, path, options)
    if (first.ok) return first
    const denied = first.status === 401 || first.status === 403 || first.status === 404
    if (!denied || !isRepoPath(path)) return first
    if (first.status === 401 && typeof onUnauthorized === 'function') {
      let renewed
      try {
        renewed = await onUnauthorized()
      } catch (error) {
        // A REFUSED refresh is terminal and typed: propagate it instead of
        // pretending the read can succeed anonymously (the login is dead, and the
        // user has to authorize again). Anything else (a network blip) falls
        // through to the anonymous attempt.
        if (error?.reason === 'refresh_refused') throw error
        renewed = undefined
      }
      if (typeof renewed === 'string' && renewed !== '' && renewed !== token) {
        const retry = await call(renewed, path, options)
        if (retry.ok) {
          meta.refreshed = true
          return retry
        }
        if (retry.status !== 401 && retry.status !== 403 && retry.status !== 404) return retry
      }
    }
    const anonymous = await anonymousCall(path, options)
    if (anonymous.ok) {
      meta.public = true
      return anonymous
    }
    // The original error is the honest one: it says what the TOKEN saw.
    return first
  }

  /** Paginate a repository READ (every page goes through `readRepo`). */
  async function paginateRead(token, path, accept, meta = {}) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const response = await readRepo(token, `${path}${separator}per_page=${PER_PAGE}&page=${page}`, { accept }, meta)
      if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}`)
      const batch = Array.isArray(response.json) ? response.json : []
      rows.push(...batch)
      if (batch.length < PER_PAGE) break
    }
    return rows
  }

  /** Collect pages while the adapter still has room to. */
  async function paginate(token, path, accept) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const response = await call(token, `${path}${separator}per_page=${PER_PAGE}&page=${page}`, { accept })
      if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}`)
      const batch = Array.isArray(response.json) ? response.json : []
      rows.push(...batch)
      if (batch.length < PER_PAGE) break
    }
    return rows
  }

  const repoPath = (owner, repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

  /** A repository's default branch, for a call that named no ref. */
  async function defaultBranch(token, owner, repo, meta = {}) {
    const response = await readRepo(token, repoPath(owner, repo), {}, meta)
    if (!response.ok) throw new Error(`GitHub ${response.status} on repository`)
    return response.json?.default_branch ?? 'HEAD'
  }

  /**
   * Resolve any commit-ish to a commit sha.
   *
   * Used where the API requires a sha rather than a name (git/trees, git/refs),
   * so a caller may pass `main`, `v1.2.3` or a sha interchangeably.
   */
  async function commitSha(token, owner, repo, ref, meta = {}) {
    const name = String(ref ?? '').trim()
    if (FULL_SHA.test(name)) return name
    const response = await readRepo(token, `${repoPath(owner, repo)}/commits/${seg(name)}`, {}, meta)
    if (!response.ok) throw new Error(`GitHub ${response.status} on commits/${name}: ref not found`)
    const sha = response.json?.sha
    if (typeof sha !== 'string' || sha === '') throw new Error(`GitHub returned no sha for ref ${name}`)
    return sha
  }

  return {
    /** The git/web origin this adapter's apiBase implies (GHE-aware). */
    get webOrigin() { return webOriginOf(base) },

    /** Token identity and the scopes GitHub reports back. */
    async whoami(token) {
      const response = await call(token, '/user')
      if (!response.ok) throw new Error(`GitHub ${response.status} on /user`)
      const user = response.json ?? {}
      return {
        login: user.login,
        name: user.name,
        scopes: String(response.headers['x-oauth-scopes'] ?? ''),
        rateLimit: response.headers['x-ratelimit-remaining'],
      }
    },

    /**
     * THE LIVENESS PROBE — one `GET /user`, classified, NEVER throwing at the
     * caller and NEVER refreshing.
     *
     * `resolved` (the reference exists) and `live` (the value still
     * authenticates) are different facts, and a status that reports only the
     * first one lies: an expired device-flow access token resolves perfectly and
     * 401s on every write, while public reads still succeed anonymously. This is
     * the cheap one-call answer to "does the token WORK", which is what a caller
     * has to know before it decides to write.
     *
     * It deliberately does NOT use `readRepo`: that path refreshes once and then
     * falls back anonymously. Status must tell the truth about the stored token,
     * not silently heal it (a refresh belongs to the operation that needed it).
     *
     * Typed states:
     *   * `live`        — 200 from `/user`;
     *   * `expired`     — 401: the token itself was refused (dead credential);
     *   * `unreachable` — a network failure or any other status. NOT dead: an
     *                     offline host or a proxy in the way says nothing about
     *                     the token, and guessing "dead" there would send the
     *                     user to a Login that cannot help.
     *
     * @param token - the resolved token to classify.
     * @returns `{ state, login?, status?, reason? }`.
     */
    async tokenState(token) {
      let response
      try {
        response = await call(token, '/user')
      } catch (error) {
        // A network/DNS/timeout failure: unknown, not expired.
        return { state: 'unreachable', reason: String(error?.message ?? error) }
      }
      if (response.ok) return { state: 'live', login: response.json?.login }
      if (response.status === 401) return { state: 'expired', status: 401, reason: 'GitHub refused the token on /user' }
      // 403 (SSO wall, suspended account) and 5xx say nothing definite about
      // expiry, so they are reported as unknown rather than as a dead credential.
      return { state: 'unreachable', status: response.status, reason: `GitHub ${response.status} on /user` }
    },

    /**
     * The token's budget, straight from the endpoint that costs nothing to ask.
     *
     * `/rate_limit` does not consume quota, which is what makes it safe to call
     * from a status read.
     */
    async rateLimit(token) {
      const response = await call(token, '/rate_limit')
      if (!response.ok) return { supported: false, reason: `GitHub ${response.status} on /rate_limit` }
      const bucket = (row) => (row === undefined || row === null
        ? undefined
        : { remaining: row.remaining, limit: row.limit, reset: row.reset })
      return {
        supported: true,
        core: bucket(response.json?.resources?.core),
        search: bucket(response.json?.resources?.search),
      }
    },

    /** Repositories the token can see. */
    async listRepos(token) {
      const rows = await paginate(token, '/user/repos?sort=updated&affiliation=owner,collaborator,organization_member')
      return rows.map(row => ({
        provider: 'github',
        fullName: row.full_name,
        owner: row.owner?.login,
        name: row.name,
        private: row.private === true,
        defaultBranch: row.default_branch,
        updatedAt: row.updated_at,
        url: row.html_url,
      }))
    },

    /** Pull requests, newest first. */
    async listPulls(token, owner, repo, state = 'open', meta = {}) {
      const rows = await paginateRead(token, `${repoPath(owner, repo)}/pulls?state=${encodeURIComponent(state)}&sort=updated&direction=desc`, ACCEPT, meta)
      return rows.map(row => ({
        number: row.number, title: row.title, state: row.state, draft: row.draft === true,
        user: row.user?.login, head: row.head?.ref, base: row.base?.ref, updatedAt: row.updated_at, url: row.html_url,
      }))
    },

    /** Issues. GitHub returns pull requests here too; they are filtered out. */
    async listIssues(token, owner, repo, state = 'open', meta = {}) {
      const rows = await paginateRead(token, `${repoPath(owner, repo)}/issues?state=${encodeURIComponent(state)}&sort=updated&direction=desc`, ACCEPT, meta)
      return rows
        .filter(row => row.pull_request === undefined)
        .map(row => ({
          number: row.number, title: row.title, state: row.state, user: row.user?.login,
          labels: (row.labels ?? []).map(label => (typeof label === 'string' ? label : label.name)),
          updatedAt: row.updated_at, url: row.html_url,
        }))
    },

    /** Branches with their head commit. */
    async listBranches(token, owner, repo, meta = {}) {
      const rows = await paginateRead(token, `${repoPath(owner, repo)}/branches`, ACCEPT, meta)
      return rows.map(row => ({
        name: row.name, sha: row.commit?.sha?.slice(0, 12), protected: row.protected === true,
      }))
    },

    /**
     * The whole tree of one ref, recursively.
     *
     * `truncated` is GitHub's own verdict (it stops at ~100k entries or 7 MB) and
     * is passed through: a caller must be able to tell "that is everything" from
     * "that is all GitHub was willing to send".
     *
     * @param token - resolved token.
     * @param owner - repository owner.
     * @param repo - repository name.
     * @param ref - branch, tag or sha; empty means the default branch.
     * @param path - optional subtree filter (prefix match).
     * @returns `{ supported, items, truncated, reason? }`.
     */
    async readTree(token, owner, repo, ref, path, meta = {}) {
      const want = String(ref ?? '').trim()
      let target = want === '' ? await defaultBranch(token, owner, repo, meta) : want
      const treePath = () => `${repoPath(owner, repo)}/git/trees/${seg(target)}?recursive=1`
      let response = await readRepo(token, treePath(), {}, meta)
      // A ref name with a slash, or a tag GitHub will not resolve as a tree, gets
      // one retry against its commit sha before this is called a miss.
      if (!response.ok && !FULL_SHA.test(target)) {
        try {
          target = await commitSha(token, owner, repo, target, meta)
          response = await readRepo(token, treePath(), {}, meta)
        } catch { /* the miss below reports it with the ref the caller used */ }
      }
      if (response.status === 404) {
        return { supported: false, items: [], truncated: false, reason: `no tree for ref "${want === '' ? '(default branch)' : want}"` }
      }
      if (!response.ok) throw new Error(`GitHub ${response.status} on git/trees`)
      const rows = Array.isArray(response.json?.tree) ? response.json.tree : []
      const prefix = path === undefined || path === '' ? '' : `${String(path).replace(/\/+$/u, '')}/`
      const items = rows
        .filter(row => prefix === '' || row.path === prefix.slice(0, -1) || String(row.path ?? '').startsWith(prefix))
        .map(row => ({ path: row.path, type: row.type, mode: row.mode, sha: row.sha, size: row.size }))
      return { supported: true, items, truncated: response.json?.truncated === true, ...(meta.public === true ? { public: true } : {}) }
    },

    /**
     * One file's bytes and identity via the contents API.
     *
     * GitHub omits `content` for files over 1 MB; that is reported as an empty
     * base64 payload with `truncated: true`, never as an empty file.
     */
    async readFile(token, owner, repo, path, ref, meta = {}) {
      const query = ref === undefined || ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`
      const response = await readRepo(token, `${repoPath(owner, repo)}/contents/${seg(path)}${query}`, {}, meta)
      if (response.status === 404) throw new Error(`GitHub 404 on contents/${path}: no such file at that ref`)
      if (!response.ok) throw new Error(`GitHub ${response.status} on contents/${path}`)
      const row = response.json ?? {}
      if (Array.isArray(row)) throw new Error(`contents/${path} is a directory; use read_tree to list it`)
      if (row.type !== undefined && row.type !== 'file') throw new Error(`contents/${path} is a ${row.type}, not a file`)
      const contentBase64 = String(row.content ?? '').replace(/\s+/gu, '')
      return {
        sha: row.sha,
        size: row.size ?? null,
        encoding: row.encoding ?? 'base64',
        contentBase64,
        // No content means GitHub refused to inline it (too large), not "empty".
        truncated: contentBase64 === '' && (row.size ?? 0) > 0,
        ...(meta.public === true ? { public: true } : {}),
      }
    },

    /**
     * Create or update one file — a commit on `branch`.
     *
     * The `sha` of the blob being replaced is what makes an update safe: without
     * it GitHub treats the call as a create and a racing writer is a 409 rather
     * than a silent overwrite.
     */
    async putFile(token, owner, repo, { path, content, message, branch, sha }) {
      const body = {
        message,
        content: Buffer.from(String(content ?? ''), 'utf8').toString('base64'),
      }
      if (branch !== undefined && branch !== '') body.branch = branch
      if (sha !== undefined && sha !== '') body.sha = sha
      const response = await call(token, `${repoPath(owner, repo)}/contents/${seg(path)}`, { method: 'PUT', body })
      if (response.status === 409) throw new Error(`GitHub 409 on contents/${path}: the sha passed is no longer the current blob — read the file again`)
      if (response.status === 422) {
        throw new Error(`GitHub 422 on contents/${path}: the file may already exist (pass sha to update it), or the branch is protected`)
      }
      if (!response.ok) throw new Error(`GitHub ${response.status} on contents/${path} (PUT)`)
      return {
        commit: response.json?.commit?.sha,
        contentSha: response.json?.content?.sha,
        path: response.json?.content?.path ?? path,
      }
    },

    /** Workflow runs, newest first. */
    async listRuns(token, owner, repo, meta = {}) {
      const response = await readRepo(token, `${repoPath(owner, repo)}/actions/runs?per_page=30`, {}, meta)
      if (response.status === 404) return { supported: false, runs: [], reason: 'Actions is not enabled for this repository' }
      if (!response.ok) throw new Error(`GitHub ${response.status} on actions/runs`)
      const runs = (response.json?.workflow_runs ?? []).map(row => ({
        id: row.id, name: row.name, branch: row.head_branch, event: row.event, status: row.status,
        conclusion: row.conclusion, createdAt: row.created_at, url: row.html_url,
      }))
      return { supported: true, runs, ...(meta.public === true ? { public: true } : {}) }
    },

    /**
     * One run's log text, per job.
     *
     * The API REQUEST has to accept JSON: `call` keeps the module default ACCEPT
     * (`application/vnd.github+json`). Only the 302 redirect TARGET serves
     * `text/plain`, and the request helper follows it; sending `Accept:
     * text/plain` on the request itself makes GitHub answer 415 Unsupported
     * 'Accept' header instead of a body.
     *
     * Nothing is read silently: a job whose log cannot be shown is named in
     * `refused`, and when no job produced text the reason comes back as the
     * text itself rather than an empty string.
     */
    async runLog(token, owner, repo, runId) {
      const detail = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`)
      if (!detail.ok) throw new Error(`GitHub ${detail.status} on actions/runs/${runId}`)
      const jobs = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/jobs`)
      if (!jobs.ok) throw new Error(`GitHub ${jobs.status} on actions/runs/${runId}/jobs`)
      const rows = Array.isArray(jobs.json?.jobs) ? jobs.json.jobs : []
      const texts = []
      const refused = []
      for (const job of rows.slice(0, MAX_LOG_JOBS)) {
        const name = job?.name ?? 'job'
        const log = await call(token, `${repoPath(owner, repo)}/actions/jobs/${encodeURIComponent(job?.id)}/logs`)
        if (looksLikeZip(log.text)) {
          refused.push(`${name}: log archive is a ZIP, not text`)
          continue
        }
        if (log.ok && typeof log.text === 'string' && log.text !== '') {
          texts.push(`--- job ${name} (${job.conclusion ?? job.status}) ---\n${log.text}`)
          continue
        }
        refused.push(`${name}: HTTP ${log.status}${log.json?.message === undefined ? '' : ` — ${log.json.message}`}`)
      }
      if (rows.length > MAX_LOG_JOBS) {
        refused.push(`+${rows.length - MAX_LOG_JOBS} more jobs beyond MAX_LOG_JOBS, truncated`)
      }
      const text = texts.length > 0
        ? texts.join('\n\n')
        : (refused.length > 0 ? `no job logs retrieved from run ${runId}:\n${refused.join('\n')}` : '')
      return { run: detail.json ?? {}, text, refused }
    },

    /**
     * `workflow_dispatch` — start a run.
     *
     * A 404 here is ambiguous on GitHub (no such workflow, Actions disabled, or a
     * workflow with no `workflow_dispatch` trigger), so the reason says all three
     * instead of pretending the dispatch happened.
     */
    async runDispatch(token, owner, repo, workflow, ref, inputs) {
      const body = { ref }
      if (inputs !== undefined && inputs !== null) body.inputs = inputs
      const response = await call(token, `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: 'POST', body })
      if (response.status === 404) {
        return { supported: false, reason: `workflow "${workflow}" was not found, has no workflow_dispatch trigger, or Actions is not enabled` }
      }
      if (!response.ok) throw new Error(`GitHub ${response.status} on actions/workflows/${workflow}/dispatches`)
      return { supported: true, dispatched: true, workflow, ref }
    },

    /** Cancel a run that is still in flight. */
    async runCancel(token, owner, repo, runId) {
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
      if (response.status === 404) return { supported: false, reason: `run ${runId} was not found` }
      if (!response.ok) throw new Error(`GitHub ${response.status} on actions/runs/${runId}/cancel`)
      return { supported: true, cancelled: true, runId: String(runId) }
    },

    /** Re-run a finished run with the same event payload. */
    async runRerun(token, owner, repo, runId) {
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' })
      if (response.status === 404) return { supported: false, reason: `run ${runId} was not found` }
      if (!response.ok) throw new Error(`GitHub ${response.status} on actions/runs/${runId}/rerun`)
      return { supported: true, rerun: true, runId: String(runId) }
    },

    /** Delete a run's record (and its logs). */
    async deleteRun(token, owner, repo, runId) {
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
      if (response.status === 404) return { supported: false, reason: `run ${runId} was not found` }
      if (!response.ok) throw new Error(`GitHub ${response.status} on actions/runs/${runId} (DELETE)`)
      return { supported: true, deleted: true, runId: String(runId) }
    },

    /** Delete a branch (its ref, not its commits). */
    async deleteBranch(token, owner, repo, branch) {
      const response = await call(token, `${repoPath(owner, repo)}/git/refs/heads/${seg(branch)}`, { method: 'DELETE' })
      if (response.status === 404) throw new Error(`GitHub 404 on git/refs/heads/${branch}: no such branch`)
      if (response.status === 422) throw new Error(`GitHub 422 on git/refs/heads/${branch}: the branch is protected`)
      if (!response.ok) throw new Error(`GitHub ${response.status} on git/refs/heads/${branch} (DELETE)`)
      return { deleted: true, branch }
    },

    /**
     * Create a tag.
     *
     * With a message GitHub gets an annotated tag object first, then a ref that
     * points at it; without one the ref points straight at the commit.
     */
    async createTag(token, owner, repo, tag, sha, message) {
      let target = sha
      if (message !== undefined && message !== '') {
        const annotated = await call(token, `${repoPath(owner, repo)}/git/tags`, {
          method: 'POST', body: { tag, message, object: sha, type: 'commit' },
        })
        if (!annotated.ok) throw new Error(`GitHub ${annotated.status} on git/tags`)
        target = annotated.json?.sha ?? sha
      }
      const response = await call(token, `${repoPath(owner, repo)}/git/refs`, {
        method: 'POST', body: { ref: `refs/tags/${tag}`, sha: target },
      })
      if (response.status === 422) throw new Error(`GitHub 422 on git/refs: tag "${tag}" already exists`)
      if (!response.ok) throw new Error(`GitHub ${response.status} on git/refs (tag)`)
      return { tag, ref: response.json?.ref, sha: response.json?.object?.sha }
    },

    /** Commit history, newest first, optionally scoped to one path. */
    async commits(token, owner, repo, { path, ref, limit } = {}, meta = {}) {
      const params = new URLSearchParams({ per_page: String(limit ?? 20) })
      if (path !== undefined && path !== '') params.set('path', path)
      if (ref !== undefined && ref !== '') params.set('sha', ref)
      const response = await readRepo(token, `${repoPath(owner, repo)}/commits?${params.toString()}`, {}, meta)
      if (response.status === 404) return []
      if (!response.ok) throw new Error(`GitHub ${response.status} on commits`)
      return (Array.isArray(response.json) ? response.json : []).map(row => ({
        sha: row.sha,
        date: row.commit?.author?.date ?? row.commit?.committer?.date,
        message: String(row.commit?.message ?? '').split('\n')[0],
        author: row.commit?.author?.name ?? row.author?.login,
      }))
    },

    /**
     * Blame is NOT part of GitHub's REST API, so this reports that rather than
     * inventing per-line attribution. The reason names the substitute.
     */
    async blame() {
      return {
        supported: false,
        items: [],
        reason: 'GitHub publishes no blame API; use commits(path, ref) for the history of a file and read_file(path, ref) for one revision',
      }
    },

    /** Resolve a commit-ish to a sha (used by create_tag and read_tree). */
    commitSha,

    /** Comment on an issue or pull request (same endpoint on GitHub). */
    async comment(token, owner, repo, number, body) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/comments`, {
        method: 'POST', body: { body },
      })
      if (!response.ok) throw new Error(`GitHub ${response.status} on issue comment`)
      return { id: response.json?.id, url: response.json?.html_url }
    },

    /** Patch an issue: title, body, state, labels. */
    async editIssue(token, owner, repo, number, patch) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}`, {
        method: 'PATCH', body: patch,
      })
      if (!response.ok) throw new Error(`GitHub ${response.status} on issue patch`)
      return { number: response.json?.number, state: response.json?.state, title: response.json?.title }
    },

    /** Comment on a pull request (the review-comment endpoint). */
    async pullComment(token, owner, repo, number, body) {
      const response = await call(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}/comments`, {
        method: 'POST', body: { body },
      })
      if (!response.ok) throw new Error(`GitHub ${response.status} on pull comment`)
      return { id: response.json?.id, url: response.json?.html_url }
    },

    /**
     * Create a branch from an existing ref.
     *
     * `POST /git/refs` requires a 40-hex commit sha — it does NOT resolve a ref
     * name, so posting `main`, a tag or an empty string verbatim is a 422. The
     * caller's `from` may be any commit-ish (or absent, meaning the default
     * branch), so it is resolved through {@link commitSha} unless it already is a
     * full sha.
     *
     * @param token - resolved token.
     * @param owner - repository owner.
     * @param repo - repository name.
     * @param options - `{ branch, from }` (or a bare branch name, positionally).
     * @param positionalFrom - `from` when the positional form is used.
     * @returns the created ref and its head sha.
     */
    async createBranch(token, owner, repo, options, positionalFrom) {
      const asked = options !== null && typeof options === 'object' ? options : { branch: options, from: positionalFrom }
      const name = String(asked.branch ?? '').trim()
      if (name === '') throw new TypeError('a branch name is required')
      const from = String(asked.from ?? '').trim()
      // `''` and `HEAD` both mean "the default branch", which git/refs cannot
      // take as text — resolve it to a sha like any other commit-ish.
      const sha = FULL_SHA.test(from) ? from : await commitSha(token, owner, repo, from === '' ? 'HEAD' : from)
      const response = await call(token, `${repoPath(owner, repo)}/git/refs`, {
        method: 'POST', body: { ref: `refs/heads/${name}`, sha },
      })
      if (response.status === 422) {
        throw new Error(`GitHub 422 on git/refs: branch "${name}" already exists, or the base commit is not in this repository`)
      }
      if (!response.ok) throw new Error(`GitHub ${response.status} on git/refs (create branch)`)
      return {
        branch: name,
        ref: response.json?.ref ?? `refs/heads/${name}`,
        sha: response.json?.object?.sha?.slice(0, 12) ?? sha.slice(0, 12),
      }
    },

    /** Open an issue. Labels are set by name, which is what this API accepts. */
    async createIssue(token, owner, repo, { title, body, labels }) {
      const payload = { title }
      if (body !== undefined && body !== '') payload.body = body
      if (Array.isArray(labels) && labels.length > 0) payload.labels = labels
      const response = await call(token, `${repoPath(owner, repo)}/issues`, { method: 'POST', body: payload })
      if (response.status === 410) throw new Error('GitHub 410 on issues: issues are disabled for this repository')
      if (!response.ok) throw new Error(`GitHub ${response.status} on issues (create)`)
      return {
        number: response.json?.number,
        url: response.json?.html_url,
        state: response.json?.state,
        labels: (response.json?.labels ?? []).map(label => (typeof label === 'string' ? label : label.name)),
      }
    },

    /** Replace the label set on an issue or pull request (`[]` clears it). */
    async setLabels(token, owner, repo, number, labels) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/labels`, {
        method: 'PUT', body: { labels },
      })
      if (!response.ok) throw new Error(`GitHub ${response.status} on issues/${number}/labels`)
      return {
        number: String(number),
        labels: (Array.isArray(response.json) ? response.json : []).map(label => (typeof label === 'string' ? label : label.name)),
      }
    },

    /** Add assignees (additive — the existing set is untouched). */
    async addAssignees(token, owner, repo, number, assignees) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/assignees`, {
        method: 'POST', body: { assignees },
      })
      if (!response.ok) throw new Error(`GitHub ${response.status} on issues/${number}/assignees`)
      return {
        number: String(number),
        assignees: (response.json?.assignees ?? []).map(user => user.login),
      }
    },

    /** Create a pull request. */
    async createPull(token, owner, repo, { head, base, title, body }) {
      const payload = { head, base, title }
      if (body !== undefined && body !== '') payload.body = body
      const response = await call(token, `${repoPath(owner, repo)}/pulls`, { method: 'POST', body: payload })
      if (response.status === 422) throw new Error('GitHub 422 on pulls: no commits between base and head, or a pull request already exists')
      if (!response.ok) throw new Error(`GitHub ${response.status} on pulls (create)`)
      return { number: response.json?.number, url: response.json?.html_url, state: response.json?.state }
    },

    /** Merge a pull request with the requested method. */
    async mergePull(token, owner, repo, number, { method = 'merge', commitTitle, commitMessage } = {}) {
      const body = { merge_method: method }
      if (commitTitle !== undefined && commitTitle !== '') body.commit_title = commitTitle
      if (commitMessage !== undefined && commitMessage !== '') body.commit_message = commitMessage
      const response = await call(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}/merge`, { method: 'PUT', body })
      if (response.status === 405) throw new Error(`GitHub 405 on pulls/${number}/merge: the pull request is not mergeable`)
      if (response.status === 409) throw new Error(`GitHub 409 on pulls/${number}/merge: the head branch changed; re-read the pull request`)
      if (response.status === 422) throw new Error(`GitHub 422 on pulls/${number}/merge: the merge could not be performed`)
      if (!response.ok) throw new Error(`GitHub ${response.status} on pulls/${number}/merge`)
      return { number: String(number), merged: response.json?.merged === true, sha: response.json?.sha, message: response.json?.message }
    },

    /** Files changed by a pull request. */
    async pullFiles(token, owner, repo, number, meta = {}) {
      const rows = await paginateRead(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}/files`, ACCEPT, meta)
      return rows.map(row => ({
        filename: row.filename, status: row.status,
        additions: row.additions, deletions: row.deletions, patch: row.patch,
      }))
    },

    /** The pull request as a unified diff (media type, not JSON). */
    async pullDiff(token, owner, repo, number, meta = {}) {
      const response = await readRepo(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}`, { accept: DIFF_ACCEPT }, meta)
      if (response.status === 404) throw new Error(`GitHub 404 on pulls/${number}`)
      if (!response.ok) throw new Error(`GitHub ${response.status} on pulls/${number} (diff)`)
      const text = typeof response.text === 'string' ? response.text : ''
      // A server that ignores the media type answers JSON. A real diff never
      // begins with `{`, so this is a safe discriminator, and reporting it is
      // better than showing an empty patch that reads as "no changes".
      if (text.trimStart().startsWith('{')) {
        return { supported: false, text: '', reason: 'this server answered with JSON for the diff media type' }
      }
      return { supported: true, text, ...(meta.public === true ? { public: true } : {}) }
    },

    /**
     * Open or close an issue.
     *
     * GitHub has no state verb of its own — this is the same `PATCH` an edit
     * uses, kept as its own method so the intent cannot be confused with a title
     * or body change.
     */
    async issueState(token, owner, repo, number, state) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}`, {
        method: 'PATCH', body: { state },
      })
      if (response.status === 404) throw new Error(`GitHub 404 on issues/${number}: no such issue`)
      if (!response.ok) throw new Error(`GitHub ${response.status} on issues/${number} (state)`)
      return { number: String(number), state: response.json?.state }
    },

    /** Whether a repository exists and what the caller may do with it. */
    async repoInfo(token, owner, repo) {
      const response = await call(token, repoPath(owner, repo))
      if (response.status === 404) return { exists: false }
      if (!response.ok) throw new Error(`GitHub ${response.status} on repository`)
      return {
        exists: true,
        private: response.json?.private === true,
        defaultBranch: response.json?.default_branch,
        permissions: response.json?.permissions ?? {},
        url: response.json?.html_url,
        // The existing repository's own clone URL, which is already correct for
        // whichever host answered the API call (public or GHE).
        cloneUrl: response.json?.clone_url,
      }
    },

    /** Create a repository, then report the clone URL the push should use. */
    async createRepo(token, name, { private: isPrivate = true, description = '' } = {}) {
      const response = await call(token, '/user/repos', {
        method: 'POST',
        body: { name, private: isPrivate, description, auto_init: false },
      })
      // 422 means the name is taken. `documentation_url` is a link to GitHub's
      // API docs, NOT a clone URL — returning it here used to send a push to the
      // docs site. Report the conflict and leave the URL to the caller, which
      // derives it from the configured origin.
      if (response.status === 422) return { created: false, reason: 'already exists' }
      if (!response.ok) throw new Error(`GitHub ${response.status} on /user/repos`)
      return {
        created: true,
        fullName: response.json?.full_name,
        cloneUrl: response.json?.clone_url,
        sshUrl: response.json?.ssh_url,
        url: response.json?.html_url,
      }
    },
  }
}
