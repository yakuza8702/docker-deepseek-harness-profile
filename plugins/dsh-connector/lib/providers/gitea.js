/**
 * Gitea adapter — a self-hosted instance at a user-supplied base URL.
 *
 * Gitea tokens go in `Authorization: token <value>` (not Bearer). The base URL
 * is a non-secret Config field the user edits from the Connector page; the token
 * is never part of it, so `https://user:token@host` is refused outright.
 *
 * CAPABILITY DETECTION is the interesting part: the Actions API only exists from
 * Gitea 1.19 and its log endpoint arrived later still, while `allowSelfSigned`
 * exists because self-hosted instances routinely run a private CA. Both are
 * probed rather than assumed, and an unsupported feature reports
 * "not supported by this server version" instead of an empty list that would
 * read as "no runs".
 *
 * THE LOG CAPABILITY COMES FROM THE ROUTE TABLE, NOT FROM A GUESSED 404
 * ---------------------------------------------------------------------
 * A 404 on `GET /repos/probe/probe/actions/runs/0/logs` says nothing about the
 * route: the repository `probe/probe` does not exist either, so a perfectly
 * capable server answered 404 and the old probe cached "no logs" forever. The
 * Swagger document is the only definitive source — a template path + method is
 * either listed or it is not — so the verdict now comes from
 * `hasRoute(…, '/repos/{owner}/{repo}/actions/runs/{run}/logs', 'get')`, and an
 * absent document leaves the answer AMBIGUOUS (`undefined`) so the call is
 * attempted and its own 404 is reported honestly.
 *
 * THE SAME RULE APPLIES TO THE EXTENDED VERBS
 * -------------------------------------------
 * `run_dispatch`, `run_cancel`, `run_rerun`, `delete_run`, `blame` and the diff
 * media type are NOT uniformly available across Gitea builds. Each is probed once
 * per adapter instance and then either used or refused with an explicit
 * `{ supported: false, reason }` — a 404 is never turned into "done", and a
 * missing route is never turned into an empty list.
 *
 * LABELS TAKE IDS ON GITEA
 * ------------------------
 * `PUT …/issues/{n}/labels` wants label ids, not names. `setLabels` therefore
 * resolves names against the repository's label list and REFUSES when a name is
 * unknown, rather than silently applying a subset.
 *
 * @module dsh-connector/lib/providers/gitea
 */

/** Path suffix appended to the configured origin. */
const API_SUFFIX = '/api/v1'

/**
 * Swagger template paths the capability checks key on.
 *
 * These are the keys the OpenAPI document uses (`{owner}`, `{repo}`, `{run}`),
 * not the URL the call is made against — the route table is written in template
 * form, so matching it against a concrete path would always fail.
 */
export const GITEA_RUN_LOG_ROUTE = '/repos/{owner}/{repo}/actions/runs/{run}/logs'
export const GITEA_JOB_LOG_ROUTE = '/repos/{owner}/{repo}/actions/runs/{run}/jobs/{job_id}/logs'

/**
 * Normalize the user-entered origin into an API root.
 *
 * Accepts `https://git.example.com`, `https://git.example.com/`, or
 * `https://git.example.com/api/v1` and produces `https://git.example.com/api/v1`.
 * Refuses anything carrying credentials, and anything that is not http(s).
 *
 * @param value - configured base URL.
 * @returns the API root, or `''` when unconfigured.
 * @throws TypeError on a malformed or credential-bearing URL.
 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  let url
  try {
    url = new URL(text)
  } catch {
    throw new TypeError('Gitea base URL must be an absolute http(s) URL, e.g. https://git.example.com')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Gitea base URL must use http or https')
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Gitea base URL must not embed credentials; the token is stored in the DSH credential store instead')
  }
  const path = url.pathname.replace(/\/+$/u, '')
  const root = path.endsWith(API_SUFFIX) ? path : `${path}${API_SUFFIX}`
  return `${url.origin}${root}`
}

/**
 * Encode one ref or file path while KEEPING its slashes — a branch called
 * `feature/x` must stay two path segments, and a subdirectory path must stay a
 * path. Each segment is still encoded, so nothing can break out of the route.
 *
 * @param value - ref name or repository path.
 * @returns the path-safe form.
 */
const seg = (value) => String(value ?? '').split('/').map(encodeURIComponent).join('/')

/**
 * Build the Gitea adapter.
 * @param options - adapter options.
 * @param options.apiBase - the user's configured origin (normalized here).
 * @param options.request - injected HTTP function.
 * @param options.version - capability cache handle shared by every call.
 * @returns the adapter.
 */
export function createGitea({ apiBase, request, version }) {
  const root = normalizeBaseUrl(apiBase)

  const call = (token, path, { method = 'GET', body, accept = 'application/json' } = {}) => request(`${root}${path}`, {
    method,
    headers: {
      accept,
      // Gitea's own scheme: `token`, not `Bearer`.
      authorization: `token ${token}`,
      'user-agent': 'dsh-connector/0.1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  async function expect(response, what) {
    if (response.ok) return response.json
    if (response.status === 404) throw new Error(`Gitea 404 on ${what}: not found, or this server version does not expose it`)
    if (response.status === 401 || response.status === 403) throw new Error(`Gitea ${response.status} on ${what}: the token was refused`)
    throw new Error(`Gitea ${response.status} on ${what}`)
  }

  /**
   * One probe per adapter instance: does this server expose the Actions API?
   * `/version` is unauthenticated and cheap, so it is asked first; the answer is
   * cached on the shared handle and refreshed only when the URL changes.
   *
   * The run-log verdict is taken from the published route table (see
   * {@link routeTable}), never from a 404 against a repository that does not
   * exist: that was the bug where a capable server was permanently recorded as
   * "no log endpoint" and `actions_logs` then claimed it was unsupported.
   */
  async function capabilities(token) {
    if (root === '') throw new Error('Gitea base URL is not configured; set it on the Connector page (Status → Gitea)')
    if (version.at !== 0 && version.baseUrl === root) return version.caps
    let semver = ''
    try {
      const probe = await request(`${root}/version`, { headers: { accept: 'application/json' } })
      if (probe.ok && typeof probe.json?.version === 'string') semver = probe.json.version
    } catch { /* an unauthenticated /version may be closed; the route table below still decides */ }
    const [major = 0, minor = 0] = semver.replace(/^v/u, '').split('.').map(part => Number.parseInt(part, 10) || 0)
    const modern = semver === '' ? undefined : major > 1 || (major === 1 && minor >= 19)
    // `true` when listed, `false` when the document definitively omits it, and
    // `undefined` when this build publishes no document — an absent table is not
    // evidence of absence, so the call is attempted and reports its own answer.
    const table = await routeTable(token)
    const caps = {
      version: semver,
      actions: modern !== false,
      actionLogs: hasRoute(table, GITEA_RUN_LOG_ROUTE, 'get'),
      routes: undefined,
    }
    version.baseUrl = root
    version.caps = caps
    version.at = Date.now()
    return caps
  }

  /**
   * Does this payload look like a ZIP archive rather than text?
   *
   * `GET …/actions/runs/{run}/logs` answers with a ZIP of per-job logs on the
   * builds that expose it, and the request helper hands back a UTF-8 decode of
   * those bytes — which renders as mojibake and looks like a corrupt log. The
   * local file header (`PK\x03\x04`) is ASCII, so it survives the decode and is
   * a reliable signal that the body must not be shown as text.
   */
  function looksLikeZip(text) {
    return typeof text === 'string' && (text.startsWith('PK\u0003\u0004') || text.startsWith('PK\u0005\u0006'))
  }


  /**
   * The route table this server publishes, read once from its OpenAPI document.
   *
   * This is the only DEFINITIVE capability check Gitea offers: a 404 on a verb is
   * ambiguous (unknown route, unknown resource, or a permission wall), while the
   * Swagger document lists exactly which paths and methods exist. When the
   * document is closed or absent the table is `null`, and callers fall back to
   * attempting the call and reporting the honest ambiguity.
   *
   * @param token - resolved token (some instances protect the document).
   * @returns a `{ paths }` map keyed by template path, or `null`.
   */
  async function routeTable(token) {
    const caps = version.caps ?? {}
    if (caps.routes !== undefined) return caps.routes
    if (version.routes !== undefined && version.baseUrl === root) return version.routes
    let table = null
    try {
      const origin = root.replace(/\/api\/v1$/u, '')
      const response = await request(`${origin}/swagger.v1.json`, {
        headers: { accept: 'application/json', authorization: `token ${token}` },
      })
      const paths = response.ok ? response.json?.paths : undefined
      if (paths !== undefined && paths !== null && typeof paths === 'object') table = paths
    } catch { table = null }
    if (caps !== undefined && typeof caps === 'object') caps.routes = table
    version.routes = table
    version.routesBaseUrl = root
    return table
  }

  /**
   * Whether one template path + method exists on this server.
   * @param table - the route table from {@link routeTable}.
   * @param template - Swagger template, e.g. `/repos/{owner}/{repo}/actions/runs/{run}/cancel`.
   * @param method - lowercase HTTP method.
   * @returns `true`, `false`, or `undefined` when the table is unavailable.
   */
  function hasRoute(table, template, method) {
    if (table === null || table === undefined) return undefined
    const entry = table[template]
    if (entry === undefined || entry === null) return false
    return Object.hasOwn(entry, method) && entry[method] !== null
  }

  /** Refusal shape shared by every capability-gated verb. */
  const unsupported = (verb, caps) => ({
    supported: false,
    reason: `${verb} is not exposed by this Gitea server${caps?.version === '' || caps?.version === undefined ? '' : ` (${caps.version})`}`,
  })

  const repoPath = (owner, repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

  /** Resolve a ref (branch, tag or sha) to a commit id where an API needs one. */
  async function commitSha(token, owner, repo, ref) {
    const name = String(ref ?? '').trim()
    if (name === '') throw new Error('a ref is required')
    const response = await call(token, `${repoPath(owner, repo)}/git/commits/${seg(name)}`)
    if (response.ok && typeof response.json?.sha === 'string') return response.json.sha
    // Older builds only resolve names through the branch/tag endpoints; fall back
    // to the ref name itself, which those endpoints accept.
    return name
  }

  /**
   * Resolve label NAMES to the ids Gitea's issue API requires.
   *
   * An unknown name is an error, never a silently smaller label set: the caller
   * asked for a specific set and must learn that one member does not exist.
   */
  async function labelIds(token, owner, repo, names) {
    const wanted = (Array.isArray(names) ? names : []).map(name => String(name).trim()).filter(name => name !== '')
    if (wanted.length === 0) return []
    const response = await call(token, `${repoPath(owner, repo)}/labels?limit=100`)
    if (!response.ok) throw new Error(`Gitea ${response.status} on labels`)
    const rows = Array.isArray(response.json) ? response.json : []
    const byName = new Map(rows.map(row => [String(row.name), row.id]))
    const missing = wanted.filter(name => !byName.has(name))
    if (missing.length > 0) throw new Error(`Gitea has no label${missing.length === 1 ? '' : 's'} named ${missing.join(', ')} in this repository`)
    return wanted.map(name => byName.get(name))
  }

  return {
    /** Where this adapter points, for the page and tool output. */
    get apiRoot() { return root },

    /** Token identity. */
    async whoami(token) {
      const user = await expect(await call(token, '/user'), '/user')
      return { login: user.login, email: user.email, admin: user.is_admin === true, version: (await capabilities(token)).version }
    },

    /**
     * THE LIVENESS PROBE — Gitea's half of the same fact.
     *
     * A self-hosted PAT or OAuth token can be revoked or expire on the instance
     * side while the reference still resolves here, so `resolved` alone is not an
     * answer either. `/user` is the cheapest authenticated route Gitea publishes
     * and needs no version probe, which is what keeps this to ONE call.
     *
     * Same typed contract as the GitHub adapter: `live` (200), `expired` (401 —
     * Gitea answers 401 for a revoked/expired token), `unreachable` for a network
     * failure or any other status (403 = a disabled account, not an expiry).
     *
     * @param token - the resolved token to classify.
     * @returns `{ state, login?, status?, reason? }`.
     */
    async tokenState(token) {
      let response
      try {
        response = await call(token, '/user')
      } catch (error) {
        return { state: 'unreachable', reason: String(error?.message ?? error) }
      }
      if (response.ok) return { state: 'live', login: response.json?.login }
      if (response.status === 401) return { state: 'expired', status: 401, reason: 'Gitea refused the token on /user' }
      return { state: 'unreachable', status: response.status, reason: `Gitea ${response.status} on /user` }
    },

    /**
     * Rate limit from the `X-RateLimit-*` headers of one authenticated probe.
     *
     * Gitea emits these only when its rate limiter is enabled (and only from
     * 1.20-ish), so an absent header means "no line to show", not "0 left".
     */
    async rateLimit(token) {
      const response = await call(token, '/user')
      const pick = (name) => {
        const raw = response.headers?.[name]
        if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
        const value = Number.parseInt(String(raw), 10)
        return Number.isFinite(value) ? value : undefined
      }
      const limit = pick('x-ratelimit-limit')
      const remaining = pick('x-ratelimit-remaining')
      const reset = pick('x-ratelimit-reset')
      if (limit === undefined && remaining === undefined && reset === undefined) {
        return { supported: false, reason: 'this Gitea server does not publish X-RateLimit-* headers' }
      }
      return {
        supported: true,
        core: {
          ...(remaining === undefined ? {} : { remaining }),
          ...(limit === undefined ? {} : { limit }),
          ...(reset === undefined ? {} : { reset }),
        },
      }
    },

    /** Repositories the token can see. */
    async listRepos(token) {
      const rows = (await expect(await call(token, '/user/repos?limit=50'), 'user/repos')) ?? []
      return rows.map(row => ({
        provider: 'gitea',
        fullName: row.full_name,
        owner: row.owner?.login,
        name: row.name,
        private: row.private === true,
        defaultBranch: row.default_branch,
        updatedAt: row.updated_at,
        url: row.html_url,
      }))
    },

    /** Pull requests. */
    async listPulls(token, owner, repo, state = 'open') {
      const rows = (await expect(await call(token, `${repoPath(owner, repo)}/pulls?state=${encodeURIComponent(state)}&limit=50`), 'pulls')) ?? []
      return rows.map(row => ({
        number: row.number, title: row.title, state: row.state, draft: row.draft === true,
        user: row.user?.login, head: row.head?.ref, base: row.base?.ref, updatedAt: row.updated_at, url: row.html_url,
      }))
    },

    /** Issues (Gitea keeps PRs in a separate endpoint, unlike GitHub). */
    async listIssues(token, owner, repo, state = 'open') {
      const rows = (await expect(await call(token, `${repoPath(owner, repo)}/issues?state=${encodeURIComponent(state)}&type=issues&limit=50`), 'issues')) ?? []
      return rows.map(row => ({
        number: row.number, title: row.title, state: row.state, user: row.user?.login,
        labels: (row.labels ?? []).map(label => label.name), updatedAt: row.updated_at, url: row.html_url,
      }))
    },

    /** Branches. */
    async listBranches(token, owner, repo) {
      const rows = (await expect(await call(token, `${repoPath(owner, repo)}/branches?limit=50`), 'branches')) ?? []
      return rows.map(row => ({ name: row.name, sha: row.commit?.id?.slice(0, 12), protected: row.protected === true }))
    },

    /**
     * The whole tree of one ref, recursively.
     *
     * `read_tree` on Gitea is `git/trees/{ref}?recursive=1`; a build that answers
     * 404 for the route is reported as unsupported rather than empty.
     */
    async readTree(token, owner, repo, ref, path) {
      const want = String(ref ?? '').trim()
      const target = want === '' ? await this.defaultBranchOf(token, owner, repo) : want
      const response = await call(token, `${repoPath(owner, repo)}/git/trees/${seg(target)}?recursive=1&per_page=1000`)
      if (response.status === 404) {
        return { supported: false, items: [], truncated: false, reason: `no tree for ref "${want === '' ? '(default branch)' : want}", or this server does not expose git/trees` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on git/trees/${target}`)
      const rows = Array.isArray(response.json?.tree) ? response.json.tree : []
      const prefix = path === undefined || path === '' ? '' : `${String(path).replace(/\/+$/u, '')}/`
      const items = rows
        .filter(row => prefix === '' || row.path === prefix.slice(0, -1) || String(row.path ?? '').startsWith(prefix))
        .map(row => ({ path: row.path, type: row.type, mode: row.mode, sha: row.sha, size: row.size }))
      return { supported: true, items, truncated: response.json?.truncated === true }
    },

    /** One file's bytes and identity through the contents API. */
    async readFile(token, owner, repo, path, ref) {
      const query = ref === undefined || ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`
      const response = await call(token, `${repoPath(owner, repo)}/contents/${seg(path)}${query}`)
      if (response.status === 404) throw new Error(`Gitea 404 on contents/${path}: no such file at that ref`)
      if (!response.ok) throw new Error(`Gitea ${response.status} on contents/${path}`)
      const row = response.json ?? {}
      if (Array.isArray(row)) throw new Error(`contents/${path} is a directory; use read_tree to list it`)
      const contentBase64 = String(row.content ?? '').replace(/\s+/gu, '')
      return {
        sha: row.sha,
        size: row.size ?? null,
        encoding: row.encoding ?? 'base64',
        contentBase64,
        truncated: contentBase64 === '' && (row.size ?? 0) > 0,
      }
    },

    /**
     * Create or update one file.
     *
     * Gitea splits this in two: POST creates, PUT updates and requires the blob
     * sha. The verb is chosen from the caller's `sha` — without one, a 422 from
     * POST is reported as "already exists, pass sha to update".
     */
    async putFile(token, owner, repo, { path, content, message, branch, sha }) {
      const body = { content: Buffer.from(String(content ?? ''), 'utf8').toString('base64'), message }
      if (branch !== undefined && branch !== '') body.branch = branch
      const update = sha !== undefined && sha !== ''
      if (update) body.sha = sha
      const response = await call(token, `${repoPath(owner, repo)}/contents/${seg(path)}`, {
        method: update ? 'PUT' : 'POST', body,
      })
      if (response.status === 422) {
        throw new Error(`Gitea 422 on contents/${path}: ${update ? 'the sha passed is not the current blob' : 'the file already exists — pass sha to update it'}`)
      }
      if (response.status === 409) throw new Error(`Gitea 409 on contents/${path}: the branch is protected or the base changed`)
      if (!response.ok) throw new Error(`Gitea ${response.status} on contents/${path} (${update ? 'PUT' : 'POST'})`)
      return {
        commit: response.json?.commit?.sha,
        contentSha: response.json?.content?.sha,
        path: response.json?.content?.path ?? path,
      }
    },

    /** The repository's default branch (used when read_tree names no ref). */
    async defaultBranchOf(token, owner, repo) {
      const response = await call(token, repoPath(owner, repo))
      if (!response.ok) throw new Error(`Gitea ${response.status} on repository`)
      return response.json?.default_branch ?? 'main'
    },

    /** Workflow runs, or an explicit "not supported" verdict. */
    async listRuns(token, owner, repo) {
      const caps = await capabilities(token)
      if (!caps.actions) {
        return { supported: false, runs: [], reason: `Actions is not supported by this server version${caps.version === '' ? '' : ` (${caps.version})`}` }
      }
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs?limit=25`)
      if (response.status === 404) {
        return { supported: false, runs: [], reason: 'Actions is not enabled for this repository' }
      }
      const rows = (await expect(response, 'actions/runs'))?.workflow_runs ?? []
      return {
        supported: true,
        runs: rows.map(row => ({
          id: row.id, name: row.name, branch: row.head_branch, event: row.event, status: row.status,
          conclusion: row.conclusion, createdAt: row.created_at, url: row.html_url,
        })),
        // `undefined` when this build publishes no route table: the answer is
        // "unknown", not "no logs" — callers must not read it as unsupported.
        logs: caps.actionLogs,
      }
    },

    /**
     * One run's log tail.
     *
     * `GET …/actions/runs/{run}/logs` answers with a ZIP ARCHIVE of per-job logs
     * on the builds that expose it, so it is never rendered as text: the bytes
     * arrive UTF-8-decoded and read as mojibake. The plain-text route is the
     * per-job one (`…/runs/{run}/jobs/{job_id}/logs`); when the server publishes
     * that, each job's text is fetched and labelled. A build that offers only the
     * archive is reported as such, with no fabricated log body.
     */
    async runLog(token, owner, repo, runId) {
      const caps = await capabilities(token)
      if (caps.actionLogs === false) {
        return { supported: false, text: '', reason: `run logs are not supported by this server version${caps.version === '' || caps.version === undefined ? '' : ` (${caps.version})`}` }
      }
      const table = await routeTable(token)

      // Preferred: the per-job plain-text endpoint. It exists on every build that
      // has Actions at all in practice, and its body IS text.
      if (hasRoute(table, GITEA_JOB_LOG_ROUTE, 'get') !== false) {
        const jobs = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/jobs?limit=50`)
        if (!jobs.ok && jobs.status === 404) {
          return { supported: false, text: '', reason: `run ${runId} was not found, or this server does not expose per-run jobs` }
        }
        if (jobs.ok) {
          const rows = Array.isArray(jobs.json?.jobs) ? jobs.json.jobs : (Array.isArray(jobs.json) ? jobs.json : [])
          const texts = []
          for (const job of rows.slice(0, 5)) {
            const jobId = job?.id
            if (jobId === undefined || jobId === null) continue
            const log = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/logs`, { accept: 'text/plain' })
            if (log.ok && typeof log.text === 'string' && log.text !== '') {
              texts.push(`--- job ${job.name ?? jobId} (${job.conclusion ?? job.status ?? 'unknown'}) ---\n${log.text}`)
            }
          }
          return { supported: true, text: texts.join('\n\n'), jobs: rows.length }
        }
      }

      // Fallback: the run-level route. It may be the ZIP archive; refuse to
      // present that as a log rather than ship mojibake.
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/logs`, { accept: 'text/plain' })
      if (response.status === 404) {
        return { supported: false, text: '', reason: `run ${runId} was not found, or this server does not expose run logs` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on actions run ${runId} logs`)
      const text = typeof response.text === 'string' ? response.text : ''
      if (looksLikeZip(text)) {
        return {
          supported: false,
          text: '',
          reason: 'this server answers run logs as a ZIP archive of per-job files, which cannot be shown as text; this build does not expose the per-job plain-text log endpoint',
        }
      }
      if (/^\s*\{"/u.test(text)) {
        return { supported: false, text: '', reason: 'this server answered the run-log route with JSON; the build does not expose a log body' }
      }
      return { supported: true, text }
    },

    /**
     * Dispatch a workflow run.
     *
     * Gitea has no documented dispatch endpoint; the probe decides whether this
     * build has one. A missing route is `{ supported: false }` — never `dispatched:
     * true` for a request that 404'd.
     */
    async runDispatch(token, owner, repo, workflow, ref, inputs) {
      const caps = await capabilities(token)
      if (!caps.actions) return unsupported('run_dispatch', caps)
      const table = await routeTable(token)
      // The workflow id is a path parameter, so the template is the stable key.
      if (hasRoute(table, '/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', 'post') === false) {
        return unsupported('run_dispatch', caps)
      }
      const body = { ref }
      if (inputs !== undefined && inputs !== null) body.inputs = inputs
      const response = await call(token, `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: 'POST', body })
      if (response.status === 404) {
        return { supported: false, reason: `workflow "${workflow}" was not found, or this server does not expose workflow dispatch` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on actions/workflows/${workflow}/dispatches`)
      return { supported: true, dispatched: true, workflow, ref }
    },

    /** Cancel a run that is still in flight. */
    async runCancel(token, owner, repo, runId) {
      const caps = await capabilities(token)
      if (!caps.actions) return unsupported('run_cancel', caps)
      const table = await routeTable(token)
      if (hasRoute(table, '/repos/{owner}/{repo}/actions/runs/{run}/cancel', 'post') === false) {
        return unsupported('run_cancel', caps)
      }
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
      if (response.status === 404) {
        return { supported: false, reason: `run ${runId} was not found, or this server does not expose run cancel` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on actions/runs/${runId}/cancel`)
      return { supported: true, cancelled: true, runId: String(runId) }
    },

    /** Re-run a finished run. */
    async runRerun(token, owner, repo, runId) {
      const caps = await capabilities(token)
      if (!caps.actions) return unsupported('run_rerun', caps)
      const table = await routeTable(token)
      if (hasRoute(table, '/repos/{owner}/{repo}/actions/runs/{run}/rerun', 'post') === false) {
        return unsupported('run_rerun', caps)
      }
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' })
      if (response.status === 404) {
        return { supported: false, reason: `run ${runId} was not found, or this server does not expose run rerun` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on actions/runs/${runId}/rerun`)
      return { supported: true, rerun: true, runId: String(runId) }
    },

    /** Delete a run's record. */
    async deleteRun(token, owner, repo, runId) {
      const caps = await capabilities(token)
      if (!caps.actions) return unsupported('delete_run', caps)
      const table = await routeTable(token)
      if (hasRoute(table, '/repos/{owner}/{repo}/actions/runs/{run}', 'delete') === false) {
        return unsupported('delete_run', caps)
      }
      const response = await call(token, `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' })
      if (response.status === 404) {
        return { supported: false, reason: `run ${runId} was not found, or this server does not expose run delete` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on actions/runs/${runId} (DELETE)`)
      return { supported: true, deleted: true, runId: String(runId) }
    },

    /**
     * Create a branch from an existing ref.
     *
     * Gitea's `POST /repos/{owner}/{repo}/branches` takes `new_branch_name` and
     * `old_ref_name` — NOT GitHub's `{ref, sha}` body, and not a sha alone: the
     * `old_ref_name` is a ref NAME (`main`, `v1.2.3`) or a sha. A 409/422 means
     * the branch already exists or the base ref does not resolve.
     *
     * The 4th argument is the documented `{ branch, from }` object; the older
     * `(name, from)` positional pair is still accepted so a caller written
     * against the previous signature keeps working.
     *
     * @param token - resolved token.
     * @param owner - repository owner.
     * @param repo - repository name.
     * @param options - `{ branch, from }` (or a bare branch name).
     * @param positionalFrom - `from` when the positional form is used.
     * @returns the created branch's name, ref and head sha.
     */
    async createBranch(token, owner, repo, options, positionalFrom) {
      const asked = options !== null && typeof options === 'object' ? options : { branch: options, from: positionalFrom }
      const name = String(asked.branch ?? '').trim()
      if (name === '') throw new Error('a branch name is required')
      // An empty `from` means "branch off the default branch"; Gitea resolves
      // `old_ref_name` itself, but the default branch name is read so the answer
      // states what it branched from.
      let base = String(asked.from ?? '').trim()
      if (base === '') {
        const repoResponse = await call(token, repoPath(owner, repo))
        base = (!repoResponse.ok ? undefined : repoResponse.json?.default_branch) ?? 'main'
      }
      const response = await call(token, `${repoPath(owner, repo)}/branches`, {
        method: 'POST', body: { new_branch_name: name, old_ref_name: base },
      })
      if (response.status === 409 || response.status === 422) {
        throw new Error(`Gitea ${response.status} on branches: branch "${name}" already exists, or "${base}" is not a ref in this repository`)
      }
      if (response.status === 404) throw new Error(`Gitea 404 on branches: no such repository, or this server does not expose branch create`)
      if (!response.ok) throw new Error(`Gitea ${response.status} on branches (create)`)
      const created = response.json?.name ?? name
      return {
        branch: created,
        ref: `refs/heads/${created}`,
        sha: response.json?.commit?.id?.slice(0, 12),
        from: base,
      }
    },

    /** Delete a branch. */
    async deleteBranch(token, owner, repo, branch) {
      const response = await call(token, `${repoPath(owner, repo)}/branches/${seg(branch)}`, { method: 'DELETE' })
      if (response.status === 404) throw new Error(`Gitea 404 on branches/${branch}: no such branch`)
      if (response.status === 403) throw new Error(`Gitea 403 on branches/${branch}: the branch is protected or the token may not delete it`)
      if (!response.ok) throw new Error(`Gitea ${response.status} on branches/${branch} (DELETE)`)
      return { deleted: true, branch }
    },

    /**
     * Create a tag. Gitea's `POST …/tags` takes a name, a target and an optional
     * message (which makes it an annotated tag).
     */
    async createTag(token, owner, repo, tag, sha, message) {
      const body = { tag_name: tag, target: sha }
      if (message !== undefined && message !== '') body.message = message
      const response = await call(token, `${repoPath(owner, repo)}/tags`, { method: 'POST', body })
      if (response.status === 409 || response.status === 422) throw new Error(`Gitea ${response.status} on tags: tag "${tag}" already exists`)
      if (!response.ok) throw new Error(`Gitea ${response.status} on tags (create)`)
      return { tag: response.json?.name ?? tag, sha: response.json?.commit?.sha ?? sha, ref: `refs/tags/${tag}` }
    },

    /** Commit history, newest first, optionally scoped to one path. */
    async commits(token, owner, repo, { path, ref, limit } = {}) {
      const params = new URLSearchParams({ limit: String(limit ?? 20) })
      if (path !== undefined && path !== '') params.set('path', path)
      if (ref !== undefined && ref !== '') params.set('sha', ref)
      const response = await call(token, `${repoPath(owner, repo)}/commits?${params.toString()}`)
      if (response.status === 404) return []
      if (!response.ok) throw new Error(`Gitea ${response.status} on commits`)
      return (Array.isArray(response.json) ? response.json : []).map(row => ({
        sha: row.sha,
        date: row.commit?.author?.date ?? row.created,
        message: String(row.commit?.message ?? '').split('\n')[0],
        author: row.commit?.author?.name ?? row.author?.login,
      }))
    },

    /**
     * Blame — `GET …/blame/{filepath}`, which only newer builds expose.
     *
     * The route is probed once; when it is absent the answer is
     * `{ supported: false }` with the version in the reason.
     */
    async blame(token, owner, repo, path, ref) {
      const caps = await capabilities(token)
      const table = await routeTable(token)
      if (hasRoute(table, '/repos/{owner}/{repo}/blame/{filepath}', 'get') === false) {
        return {
          supported: false,
          items: [],
          reason: `blame is not exposed by this Gitea server${caps.version === '' ? '' : ` (${caps.version})`}`,
        }
      }
      const query = ref === undefined || ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`
      const response = await call(token, `${repoPath(owner, repo)}/blame/${seg(path)}${query}`)
      if (response.status === 404) {
        return { supported: false, items: [], reason: `blame is not available for ${path} on this server (route absent for that file or build)` }
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on blame/${path}`)
      const rows = Array.isArray(response.json) ? response.json : []
      return {
        supported: true,
        items: rows.map(part => ({
          sha: part.commit?.sha,
          author: part.commit?.author?.name ?? part.commit?.author?.login,
          date: part.commit?.author?.date ?? part.commit?.created,
          lines: Array.isArray(part.lines)
            ? (part.lines.length === 2 ? [part.lines[0], part.lines[0] + part.lines[1] - 1] : part.lines)
            : [],
        })),
      }
    },

    /** Comment on an issue or pull request. */
    async comment(token, owner, repo, number, body) {
      const result = await expect(await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/comments`, { method: 'POST', body: { body } }), 'issue comment')
      return { id: result?.id, url: result?.html_url }
    },

    /** Patch an issue. */
    async editIssue(token, owner, repo, number, patch) {
      const result = await expect(await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}`, { method: 'PATCH', body: patch }), 'issue patch')
      return { number: result?.number, state: result?.state, title: result?.title }
    },

    /** Comment on a pull request (Gitea's issue-comment path). */
    async pullComment(token, owner, repo, number, body) {
      return this.comment(token, owner, repo, number, body)
    },

    /** Open an issue. Label NAMES are resolved to ids first. */
    async createIssue(token, owner, repo, { title, body, labels }) {
      const ids = await labelIds(token, owner, repo, labels)
      const payload = { title }
      if (body !== undefined && body !== '') payload.body = body
      if (ids.length > 0) payload.labels = ids
      const response = await call(token, `${repoPath(owner, repo)}/issues`, { method: 'POST', body: payload })
      if (!response.ok) throw new Error(`Gitea ${response.status} on issues (create)`)
      return {
        number: response.json?.number,
        url: response.json?.html_url,
        state: response.json?.state,
        labels: (response.json?.labels ?? []).map(label => label.name),
      }
    },

    /** Open or close an issue (Gitea uses the same PATCH as an edit). */
    async issueState(token, owner, repo, number, state) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}`, { method: 'PATCH', body: { state } })
      if (!response.ok) throw new Error(`Gitea ${response.status} on issues/${number} (state)`)
      return { number: String(number), state: response.json?.state }
    },

    /** Replace the label set (`[]` clears it). Names are resolved to ids. */
    async setLabels(token, owner, repo, number, labels) {
      const ids = await labelIds(token, owner, repo, labels)
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/labels`, {
        method: 'PUT', body: { labels: ids },
      })
      if (!response.ok) throw new Error(`Gitea ${response.status} on issues/${number}/labels`)
      return {
        number: String(number),
        labels: (Array.isArray(response.json) ? response.json : []).map(label => label.name),
      }
    },

    /** Add assignees (additive). */
    async addAssignees(token, owner, repo, number, assignees) {
      const response = await call(token, `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/assignees`, {
        method: 'POST', body: { assignees },
      })
      if (!response.ok) throw new Error(`Gitea ${response.status} on issues/${number}/assignees`)
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
      if (response.status === 409 || response.status === 422) {
        throw new Error(`Gitea ${response.status} on pulls: no commits between base and head, or a pull request already exists`)
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on pulls (create)`)
      return { number: response.json?.number, url: response.json?.html_url, state: response.json?.state }
    },

    /**
     * Merge a pull request.
     *
     * Gitea names the method `Do` and takes the title/message as
     * `MergeTitleField` / `MergeMessageField`; the caller's three generic method
     * names map onto Gitea's set.
     */
    async mergePull(token, owner, repo, number, { method = 'merge', commitTitle, commitMessage } = {}) {
      const body = { Do: method }
      if (commitTitle !== undefined && commitTitle !== '') body.MergeTitleField = commitTitle
      if (commitMessage !== undefined && commitMessage !== '') body.MergeMessageField = commitMessage
      const response = await call(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}/merge`, { method: 'POST', body })
      if (response.status === 404) throw new Error(`Gitea 404 on pulls/${number}/merge: the pull request was not found`)
      if (response.status === 405 || response.status === 409) {
        throw new Error(`Gitea ${response.status} on pulls/${number}/merge: the pull request is not mergeable`)
      }
      if (!response.ok) throw new Error(`Gitea ${response.status} on pulls/${number}/merge`)
      // Gitea answers 200 with an empty body on success and does not return a sha.
      return { number: String(number), merged: true, sha: response.json?.sha, message: response.json?.message }
    },

    /** Files changed by a pull request. */
    async pullFiles(token, owner, repo, number) {
      const rows = (await expect(await call(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}/files?limit=100`), 'pulls/files')) ?? []
      return rows.map(row => ({
        filename: row.filename, status: row.status,
        additions: row.additions, deletions: row.deletions, patch: row.patch,
      }))
    },

    /** The pull request as a unified diff (`.diff` suffix, not a media type). */
    async pullDiff(token, owner, repo, number) {
      const response = await call(token, `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}.diff`, { accept: 'text/plain' })
      if (response.status === 404) return { supported: false, text: '', reason: `pull request ${number} was not found, or this server does not serve the .diff suffix` }
      if (!response.ok) throw new Error(`Gitea ${response.status} on pulls/${number}.diff`)
      const text = typeof response.text === 'string' ? response.text : ''
      if (text.trimStart().startsWith('{')) {
        return { supported: false, text: '', reason: 'this server answered with JSON for the .diff suffix' }
      }
      return { supported: true, text }
    },

    /** Create a repository; `exists` when the name is taken. */
    async createRepo(token, name, { private: isPrivate = true, description = '' } = {}) {
      const response = await call(token, '/user/repos', {
        method: 'POST',
        body: { name, private: isPrivate, description, auto_init: false },
      })
      if (response.status === 409 || response.status === 422) {
        return { created: false, reason: 'already exists', cloneUrl: `${root.replace(/\/api\/v1$/u, '')}/${name}.git` }
      }
      const result = await expect(response, '/user/repos')
      return { created: true, fullName: result?.full_name, cloneUrl: result?.clone_url, url: result?.html_url }
    },

    /** Repo existence and the caller's permission block. */
    async repoInfo(token, owner, repo) {
      const response = await call(token, repoPath(owner, repo))
      if (response.status === 404) return { exists: false }
      const result = await expect(response, 'repository')
      return {
        exists: true,
        private: result?.private === true,
        defaultBranch: result?.default_branch,
        permissions: result?.permissions ?? {},
        url: result?.html_url,
        cloneUrl: result?.clone_url,
      }
    },

    /** Resolve a commit-ish to a sha (shared with the operations layer). */
    commitSha,
  }
}
