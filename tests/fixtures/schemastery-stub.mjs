/**
 * schemastery-stub.mjs — the two schema calls `index.js` makes at module scope.
 *
 * `plugins/dsh-cua-vm/index.js` declares its Config with
 * `@deepseek-ai/schemastery`. A gate test has no reason to load the harness's
 * own copy (it lives in the DSH checkout, not in this repository), and the
 * plugin never validates through the schema at runtime — `apply(ctx, config)`
 * reads `config.socketPath ?? default`. This stub keeps the chainable shape so
 * the Config declaration itself is still EXECUTED (a syntax or shape error in it
 * would still fail the test).
 */

function node(type) {
  const self = {
    type,
    _meta: {},
    min() { return self },
    max() { return self },
    step() { return self },
    default() { return self },
    description() { return self },
    required() { return self },
    optional() { return self },
    pattern() { return self },
    enum() { return self }
  }
  return self
}

const z = {
  object: () => node('object'),
  string: () => node('string'),
  number: () => node('number'),
  boolean: () => node('boolean'),
  array: () => node('array'),
  union: () => node('union'),
  any: () => node('any'),
  const: (value) => Object.assign(node('const'), { value })
}

export default z
export { z }
