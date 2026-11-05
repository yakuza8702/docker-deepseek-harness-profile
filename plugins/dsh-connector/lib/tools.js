/**
 * Connector agent tools — `connector_*`.
 *
 * Six tools, one per verb family, all delegating to `lib/operations.js` so the
 * page routes and the model share one implementation. The tool surface is
 * deliberately small: a `status` that never shows a token, a repo list, one
 * shared `repo_actions` tool with an `action` discriminator, a `file` tool for
 * repository content, `push` which is dry-run by default, and one Cloudflare
 * platform tool (`connector_cloudflare`) covering zones, DNS, WAF, access rules,
 * zone settings, DDoS overrides and analytics.
 *
 * WHAT THE MODEL NEVER SEES
 * -------------------------
 * A credential value. This plugin is reference-only: an alias names a DSH
 * credential reference (`GITHUB_TOKEN`) and the plugin asks DSH to resolve it at
 * call time. `connector_status` reports the reference name and whether it
 * resolves — never the value, its length, or any mask of it. No tool accepts a
 * credential as an argument, and the prompt section tells the model never to ask
 * for one.
 *
 * APPROVAL BOUNDARY
 * -----------------
 * Read verbs are unrestricted. Write verbs are the caller's approval-preset
 * business, and every description below says which is which IN THE ACTION LIST
 * ITSELF, so a model that reads only the enum still knows what it is about to do:
 *
 *   reads   prs, issues, branches, actions_logs, commits, blame, pr_files, pr_diff
 *           read_tree, read_file
 *   writes  comment, edit_issue, pull_comment, create_branch, run_dispatch,
 *           run_cancel, run_rerun, delete_run, delete_branch, create_tag,
 *           set_labels, add_assignees, issue_create, issue_state, pr_create,
 *           pr_merge, put_file, push
 *
 * @module dsh-connector/lib/tools
 */

import { PROVIDERS } from './credentials.js'
import {
  READ_ACTIONS, WRITE_ACTIONS, FILE_READ_ACTIONS, FILE_WRITE_ACTIONS,
  CLOUDFLARE_READ_ACTIONS, CLOUDFLARE_WRITE_ACTIONS,
} from './operations.js'

/**
 * THE MARKERS — one source of truth for the read/write split in prose.
 *
 * Every tool description opens with one of these two tokens, and the prompt
 * section defines what each means ONCE. That is what keeps six descriptions from
 * repeating the approval rule six times: the token is the whole contract, and a
 * model that reads only a description still knows whether the call needs the
 * session's go-ahead. Exported so the tests assert the same vocabulary the
 * descriptions use instead of a copy of it.
 */
const READ_MARK = 'READ ✓'
const WRITE_MARK = 'WRITE ⚠'
/**
 * The secrecy marker.
 *
 * It used to open every description; the second compression pass moved it into the
 * prompt section, which states it once ("`no value in or out`"), because six
 * copies of one clause is exactly the boilerplate this surface cannot afford.
 * Still exported — the vocabulary is shared, and a test may assert on the token
 * rather than on the sentence.
 */
const SECRECY_MARK = 'no value in or out'

/** Text output envelope shared by every tool here. */
const textOutput = (description) => ({
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string', description } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
})

/** One line per alias: `github · default · ref GITHUB_TOKEN · resolved (env)`. */
function aliasLines(report) {
  const lines = []
  for (const provider of report.providers ?? []) {
    const aliases = provider.aliases ?? []
    if (aliases.length === 0) {
      lines.push(`${provider.provider}: default alias "${provider.defaultAlias}" has no reference set`)
      continue
    }
    for (const row of aliases) {
      const state = row.resolved
        ? `resolved${row.source === undefined ? '' : ` (${row.source})`}`
        : 'not resolved — store this credential in DSH'
      lines.push(`${provider.provider} · ${row.alias} · ref ${row.credentialRef || '(none set)'} · ${state}`)
    }
    if (provider.rateLimit !== undefined) {
      const budget = provider.rateLimit
      if (budget.supported === false) {
        lines.push(`  rate limit: not published${typeof budget.reason === 'string' ? ` — ${budget.reason}` : ''}`)
      } else {
        for (const bucket of ['core', 'search']) {
          const row = budget[bucket]
          if (row === undefined) continue
          const parts = []
          if (row.remaining !== undefined) parts.push(`${row.remaining} remaining`)
          if (row.limit !== undefined) parts.push(`of ${row.limit}`)
          if (row.reset !== undefined) parts.push(`resets ${new Date(row.reset * 1000).toISOString()}`)
          lines.push(`  rate limit (${bucket}): ${parts.join(' ')}`)
        }
      }
    }
  }
  return lines
}

/**
 * The action list, rendered as quoted names for the tool description.
 *
 * The quotes are deliberate: they make the verb set in the prose byte-identical to
 * the enum, so a test (and a model) can match one to the other without guessing at
 * separators. It is the only decoration the compressed text keeps.
 */
const actionList = (set, fileSet) => [...set].map(name => `"${name}"`).join(', ')

/** Build a compact one-line-per-item view of an `items` result. */
function itemLines(result) {
  const rows = result.items ?? []
  switch (result.action) {
    case 'branches':
      return rows.map(row => `${row.name}${row.protected === true ? ' · protected' : ''} · ${row.sha ?? ''}`)
    case 'commits':
      return rows.map(row => `${String(row.sha ?? '').slice(0, 12)} · ${row.date ?? ''} · ${row.author ?? ''} · ${row.message ?? ''}`)
    case 'blame':
      return rows.map(row => `${String(row.sha ?? '').slice(0, 12)} · ${row.author ?? ''} · ${row.date ?? ''} · lines ${(row.lines ?? []).join('-')}`)
    case 'pr_files':
      return rows.map(row => `${row.filename} · ${row.status} · +${row.additions ?? 0}/-${row.deletions ?? 0}`)
    default:
      return rows.map(row => `#${row.number} ${row.title}${row.state === undefined ? '' : ` · ${row.state}`}${row.user === undefined ? '' : ` · @${row.user}`}`)
  }
}

/** Fields that describe the envelope rather than the outcome. */
const ENVELOPE = new Set(['ok', 'provider', 'alias', 'action', 'owner', 'repo', 'count', 'items', 'supported', 'reason', 'text', 'truncated'])

/**
 * Build the tool definitions for one host.
 * @param options - wiring.
 * @param options.operations - the operations facade.
 * @returns the definitions, ready for `ctx.tools.register`.
 */
export function createTools({ operations }) {
  return [
    {
      name: 'connector_status',
      // Read-only. FIRST call: tells the model which alias/ref to use before any other tool.
      description: `${READ_MARK}. First call: per alias ref name, resolved?, budget, OAuth state; rateLimit:false skips the budget.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', enum: PROVIDERS, description: 'One provider only.' },
          alias: { type: 'string', description: 'One alias only.' },
          rateLimit: { type: 'boolean', description: 'Budget probe, default true.' },
        },
      },
      output: textOutput('Alias, ref name, resolved state.'),
      async execute(args = {}) {
        const report = await operations.status({
          provider: args.provider,
          alias: args.alias,
          // On by default: the budget is part of what "status" answers. A caller
          // that wants a cheap, token-free listing passes rateLimit:false.
          rateLimit: args.rateLimit !== false,
        })
        const lines = aliasLines(report)
        lines.push('the credential value is managed by DSH; this plugin stores only the reference name')
        if (report.storePath !== undefined) lines.push(`DSH credential document: ${report.storePath}`)
        return { text: lines.join('\n') }
      },
    },

    {
      name: 'connector_repos_list',
      // Read-only.
      description: `${READ_MARK}. Repos the alias sees.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['provider'],
        properties: {
          provider: { type: 'string', enum: PROVIDERS },
          alias: { type: 'string', description: 'Default: provider default.' },
        },
      },
      output: textOutput('Repos, one per line.'),
      async execute(args = {}) {
        const result = await operations.repos({ provider: args.provider, alias: args.alias })
        if (result.count === 0) return { text: `No repositories visible for ${result.provider} (alias ${result.alias}).` }
        const lines = result.items.map(item => `${item.fullName}${item.private === true ? ' · private' : ''}${item.defaultBranch === undefined || item.defaultBranch === '' ? '' : ` · ${item.defaultBranch}`}${item.updatedAt === undefined ? '' : ` · updated ${item.updatedAt}`}`)
        return { text: `${result.count} ${result.provider} repositor${result.count === 1 ? 'y' : 'ies'} (alias ${result.alias}):\n${lines.join('\n')}` }
      },
    },

    {
      name: 'connector_repo_actions',
      description: [
        `${READ_MARK} / ${WRITE_MARK} — one repo; \`action\` discriminates.`,
        `${READ_MARK}: ${actionList(READ_ACTIONS)} — lists; actions_logs → runs or one log tail; commits → history; blame → line ranges; pr_files → changed files; pr_diff → diff.`,
        `${WRITE_MARK} approval: ${actionList(WRITE_ACTIONS)} — set_labels replaces, add_assignees appends, pr_merge takes method.`,
        'GH: CI + run verbs · Gitea: capability-detect (Swagger), Actions verbs degrade unsupported.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'action'],
        properties: {
          provider: { type: 'string', enum: PROVIDERS },
          action: {
            type: 'string',
            enum: [...READ_ACTIONS, ...WRITE_ACTIONS],
            description: 'Listed above: READ ✓ or WRITE ⚠.',
          },
          alias: { type: 'string' },
          owner: { type: 'string', description: 'Owner. Cloudflare: account id.' },
          repo: { type: 'string', description: 'Repo. Cloudflare: Pages project.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'prs/issues filter; issue_state target.' },
          ref: { type: 'string', description: 'commits/blame: branch/tag/sha.' },
          path: { type: 'string', description: 'commits/blame: scope to this path.' },
          limit: { type: 'number', description: 'commits: 1-100, default 20.' },
          runId: { type: 'string', description: 'actions_logs target; or the run to act on.' },
          workflow: { type: 'string', description: 'run_dispatch: ci.yml or id.' },
          inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'run_dispatch inputs.' },
          number: { type: 'string', description: 'Issue/PR number.' },
          body: { type: 'string', description: 'Body text.' },
          title: { type: 'string', description: 'Title.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'set_labels replaces; empty clears.' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'add_assignees: logins, appended.' },
          branch: { type: 'string', description: 'create_branch: new name; delete_branch: target.' },
          from: { type: 'string', description: 'create_branch: branch from this.' },
          tag: { type: 'string', description: 'create_tag: tag name.' },
          sha: { type: 'string', description: 'create_tag: target commit.' },
          message: { type: 'string', description: 'create_tag: makes it annotated.' },
          head: { type: 'string', description: 'pr_create: source branch.' },
          base: { type: 'string', description: 'pr_create: target branch.' },
          method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'pr_merge: method.' },
          commitTitle: { type: 'string', description: 'pr_merge: commit title.' },
          commitMessage: { type: 'string', description: 'pr_merge: commit message.' },
        },
      },
      output: textOutput('List, log tail, diff, or write receipt.'),
      async execute(args = {}) {
        const result = await operations.repoAction(args)

        // Capability/unsupported verdicts first: they are the whole answer.
        if (result.supported === false) {
          const head = `${result.action} on ${result.provider}: not supported — ${result.reason}`
          return { text: result.text === '' || result.text === undefined ? head : `${head}\n${result.text}` }
        }
        if (typeof result.text === 'string' && result.text !== '') {
          return {
            text: `${result.action} ${result.number === undefined ? '' : `#${result.number} `}(${result.truncated === true ? 'tail, truncated' : 'complete'}):\n${result.text}`,
          }
        }
        if (result.action === 'actions_logs' && Array.isArray(result.items)) {
          const rows = result.items.map(row => `${row.id} · ${row.name ?? row.url ?? ''} · ${row.status ?? ''}${row.conclusion === undefined || row.conclusion === null ? '' : `/${row.conclusion}`}`)
          return { text: rows.length === 0 ? 'No runs found.' : `${rows.length} run(s):\n${rows.join('\n')}` }
        }
        if (Array.isArray(result.items) && result.items.length > 0 && result.action !== 'actions_logs') {
          const lines = itemLines(result)
          const scope = result.path === undefined ? '' : ` · ${result.path}`
          return { text: `${result.count} ${result.action} in ${result.owner}/${result.repo}${scope} (alias ${result.alias}):\n${lines.join('\n')}` }
        }
        if (Array.isArray(result.items) && result.items.length === 0 && READ_ACTIONS.has(result.action)) {
          return { text: `No ${result.action} found in ${result.owner}/${result.repo}${result.path === undefined ? '' : ` for ${result.path}`}.` }
        }

        const receipt = Object.entries(result)
          .filter(([field]) => !ENVELOPE.has(field))
          .map(([field, value]) => `${field}=${value === null || value === undefined ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
          .join(' · ')
        return { text: `${result.action} on ${result.provider} ${result.owner}/${result.repo}: ${receipt}` }
      },
    },

    {
      name: 'connector_file',
      description: [
        `${READ_MARK} / ${WRITE_MARK} — repo content; \`action\` discriminates.`,
        `${READ_MARK}: read_tree (recursive; path = optional prefix; truncation flagged), read_file → {contentBase64, utf8, size, sha}.`,
        `${WRITE_MARK} approval (commit): put_file — whole text to one path; sha replaces, omit creates; paths repo-relative.`,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'action', 'owner', 'repo'],
        properties: {
          provider: { type: 'string', enum: PROVIDERS },
          action: { type: 'string', enum: [...FILE_READ_ACTIONS, ...FILE_WRITE_ACTIONS], description: `${READ_MARK} or ${WRITE_MARK}.` },
          owner: { type: 'string', description: 'Owner.' },
          repo: { type: 'string', description: 'Repo.' },
          ref: { type: 'string', description: 'Branch/tag/sha.' },
          path: { type: 'string', description: 'read_tree: prefix; else file path.' },
          content: { type: 'string', description: 'put_file: whole text, ≤4 MiB.' },
          message: { type: 'string', description: 'put_file: commit message.' },
          branch: { type: 'string', description: 'put_file: target branch.' },
          sha: { type: 'string', description: 'put_file: blob sha to replace.' },
          alias: { type: 'string' },
        },
      },
      output: textOutput('Tree, content, or commit receipt.'),
      async execute(args = {}) {
        const result = await operations.fileAction(args)
        if (result.action === 'read_tree') {
          if (result.supported === false) return { text: `read_tree on ${result.provider}: not available — ${result.reason}` }
          const lines = (result.items ?? []).map(row => `${row.type === 'tree' ? 'dir ' : 'file'} ${row.path}${row.size === undefined ? '' : ` (${row.size} B)`}`)
          return {
            text: `${result.count} entries at ${result.owner}/${result.repo}@${result.ref}${result.path === '/' ? '' : ` under ${result.path}`}${result.truncated === true ? ' — TRUNCATED by the server, there are more' : ''}:\n${lines.join('\n')}`,
          }
        }
        if (result.action === 'read_file') {
          const header = `${result.path} at ${result.ref} · sha ${String(result.sha ?? '').slice(0, 12)} · ${result.size ?? '?'} B${result.truncated === true ? ' · content not inlined by the server' : ''}`
          if (typeof result.utf8 === 'string') return { text: `${header}\n\n${result.utf8}` }
          return { text: `${header}\n\n(binary or unavailable content; base64 payload is ${result.contentBase64 === '' ? 'empty' : `${result.contentBase64.length} chars`})` }
        }
        return {
          text: `put_file on ${result.provider} ${result.owner}/${result.repo}: ${result.path} → ${result.branch} · ${result.bytes} B · commit ${String(result.commit ?? '').slice(0, 12) || '(no sha returned)'} · blob ${String(result.contentSha ?? '').slice(0, 12) || '(none)'}`,
        }
      },
    },

    {
      name: 'connector_cloudflare',
      description: [
        `${READ_MARK} / ${WRITE_MARK} — Cloudflare only; \`action\` discriminates.`,
        `${READ_MARK}: ${actionList(CLOUDFLARE_READ_ACTIONS)} — one zone; access_rules: zone|account.`,
        `${WRITE_MARK} approval: ${actionList(CLOUDFLARE_WRITE_ACTIONS)} — waf_rule_set replaces a phase entry point; waf_rule_patch with enabled:false alone pauses.`,
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [...CLOUDFLARE_READ_ACTIONS, ...CLOUDFLARE_WRITE_ACTIONS],
            description: 'Listed above: READ ✓ or WRITE ⚠.',
          },
          alias: { type: 'string' },
          zone: { type: 'string', description: 'Zone id (32 hex).' },
          account: { type: 'string', description: 'Account id (32 hex).' },
          scope: { type: 'string', enum: ['zone', 'account'], description: 'access_rules owner.' },
          page: { type: 'number', description: 'Page (1-10000).' },
          per_page: { type: 'number', description: 'Size (1-100).' },
          type: { type: 'string', description: 'DNS type.' },
          name: { type: 'string', description: 'DNS name; ruleset name.' },
          content: { type: 'string', description: 'DNS content.' },
          ttl: { type: 'number', description: '1 auto, else 60-86400.' },
          proxied: { type: 'boolean', description: 'A/AAAA/CNAME only.' },
          priority: { type: 'number', description: 'MX/SRV.' },
          comment: { type: 'string' },
          record_id: { type: 'string', description: '32 hex.' },
          phase: { type: 'string', enum: ['http_request_firewall_custom', 'http_ratelimit', 'http_request_firewall_managed'], description: 'WAF phase.' },
          ruleset_id: { type: 'string', description: '32 hex.' },
          rule_id: { type: 'string', description: '32 hex.' },
          rule: { type: 'object', additionalProperties: true, description: 'One WAF rule.' },
          rules: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Replacement rules.' },
          description: { type: 'string', description: 'Ruleset description.' },
          setting_id: { type: 'string', description: 'e.g. security_level.' },
          target: { type: 'string', enum: ['ip', 'ip_range', 'asn', 'country'], description: 'Target kind.' },
          rule_value: { type: 'string', description: 'IP/range/ASN/country.' },
          mode: { type: 'string', enum: ['block', 'challenge', 'managed_challenge', 'js_challenge', 'whitelist'], description: 'Access-rule mode.' },
          notes: { type: 'string' },
          setting_value: { type: 'string', description: 'New value.' },
          since: { type: 'string', description: 'ISO-8601.' },
          until: { type: 'string', description: 'ISO-8601.' },
          limit: { type: 'number', description: '1-1000.' },
          asn: { type: 'number', description: 'botnet_feed: ASN 1-4294967295.' },
          report: { type: 'string', enum: ['full_report', 'day_report'], description: 'botnet_feed report kind.' },
          date: { type: 'string', description: 'day_report date (YYYY-MM-DD).' },
          httpManagedRulesetId: { type: 'string', description: 'ddos_override_set: managed ruleset id (32 hex).' },
          overrides: { type: 'object', additionalProperties: true, description: 'ddos_override_set: overrides object.' },
        },
      },
      output: textOutput('Cloudflare action result.'),
      async execute(args = {}) {
        const result = await operations.cloudflareAction(args)
        const head = `Cloudflare ${result.action} (alias ${result.alias})`
        if (result.action === 'zones') {
          return { text: `${head}: ${result.count} zone(s)\n${result.items.map(zone => `${zone.id} · ${zone.name} · ${zone.status}`).join('\n')}` }
        }
        if (result.action === 'dns_records' || result.action === 'access_rules' || result.action === 'zone_settings') {
          const rows = result.items.map(item => Object.entries(item).filter(([, entry]) => entry !== undefined).map(([key, entry]) => `${key}=${String(entry)}`).join(' · ')).join('\n')
          return { text: `${head}: ${result.count} item(s)\n${rows}${result.ttlSemantics === undefined ? '' : `\n${result.ttlSemantics}`}` }
        }
        // A ddos_l7 entry point that answers 404 means "no overrides yet": the
        // friendly read, checked before the ruleset dereference below.
        if (result.action === 'ddos_overrides' && result.defaultsActive === true) {
          return { text: `${head}: zone ${result.zone} — ${result.note}` }
        }
        if (result.action === 'waf_rules' || result.action === 'ddos_overrides') {
          if (result.ruleset === undefined) {
            return { text: `${head}: ${result.count} ruleset(s)\n${result.items.map(item => `${item.id} · ${item.phase} · ${item.name}`).join('\n')}` }
          }
          return { text: `${head}: ${result.ruleset.phase} v${result.ruleset.version} — ${result.ruleset.rules.length} rule(s)\n${result.ruleset.rules.map(rule => `${rule.id} · ${rule.action} · ${rule.expression}`).join('\n')}` }
        }
        if (result.action === 'analytics') return { text: `${head}: zone ${result.zone}\n${JSON.stringify(result.data)}` }
        if (result.action === 'security_events') {
          const rows = result.events.map(event => `${event.datetime} · ${event.action} · ${event.clientIP} · ${event.clientRequestHTTPHost}${event.clientRequestPath} · rule ${event.ruleId ?? '-'}`)
          return { text: `${head}: zone ${result.zone} — ${result.count} event(s)\n${rows.join('\n')}` }
        }
        if (result.action === 'botnet_feed') {
          if (result.supported === false) return { text: `${head}: not available — ${result.reason}` }
          return { text: `${head}: ASN ${result.asn} ${result.report}${result.date === undefined ? '' : ` ${result.date}`}\n${JSON.stringify(result.feed)}` }
        }
        return { text: `${head}: ${result.changed === true ? 'CHANGED' : 'OK'}\n${JSON.stringify(result.rule ?? result.record ?? result.setting ?? result.ruleset ?? {})}` }
      },
    },

    {
      name: 'connector_push',
      description: `${WRITE_MARK} approval. Dry-run default: plan, then dryRun:false once the user agrees.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'path'],
        properties: {
          provider: { type: 'string', enum: PROVIDERS },
          path: { type: 'string', description: 'Dir inside the workspace.' },
          owner: { type: 'string', description: 'Owner. Cloudflare: account id.' },
          repo: { type: 'string', description: 'Repo. Cloudflare: Pages project.' },
          ref: { type: 'string', description: 'Default: local branch.' },
          alias: { type: 'string' },
          private: { type: 'boolean', description: 'Default true.' },
          dryRun: { type: 'boolean', description: 'Default true: plan only.' },
        },
      },
      output: textOutput('Plan, or result with redacted git output.'),
      async execute(args = {}) {
        const result = await operations.push({
          provider: args.provider,
          path: args.path,
          owner: args.owner,
          repo: args.repo,
          ref: args.ref,
          alias: args.alias,
          private: args.private,
          dryRun: args.dryRun !== false,
        })
        if (result.dryRun === true) {
          return { text: `DRY RUN — nothing was sent.\n${result.summary}\npath=${result.path}\nbranch=${result.branch}\nhead=${result.head === '' ? '(none)' : result.head}\nuncommitted=${result.dirtyFiles}${result.dirtySample.length === 0 ? '' : `\n${result.dirtySample.join('\n')}`}\n\nRepeat with dryRun=false to push.` }
        }
        return { text: `${result.ok ? 'OK' : 'FAILED'} — ${result.summary}\n${result.output ?? ''}` }
      },
    },
  ]
}

export {
  READ_ACTIONS, WRITE_ACTIONS, FILE_READ_ACTIONS, FILE_WRITE_ACTIONS,
  CLOUDFLARE_READ_ACTIONS, CLOUDFLARE_WRITE_ACTIONS,
  READ_MARK, WRITE_MARK, SECRECY_MARK,
}
