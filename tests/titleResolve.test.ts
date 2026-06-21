import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { heuristicTitle, issueTitle, proposeTitle, sanitizeTitle } from '../src/shared/titleResolve'

test('precedence: manual beats issue beats ai beats default', () => {
  const manual = { title: 'My name', titleSource: 'manual' as const }
  assert.equal(proposeTitle(manual, { title: '#1 · x', source: 'issue' }), null)
  assert.equal(proposeTitle(manual, { title: 'AI', source: 'ai' }), null)

  const issue = { title: '#1 · x', titleSource: 'issue' as const }
  assert.equal(proposeTitle(issue, { title: 'AI', source: 'ai' }), null)
  assert.deepEqual(proposeTitle(issue, { title: 'Renamed', source: 'manual' }), {
    title: 'Renamed',
    titleSource: 'manual'
  })

  const def = { title: 'Untitled session', titleSource: 'default' as const }
  assert.deepEqual(proposeTitle(def, { title: 'Fix login', source: 'ai' }), {
    title: 'Fix login',
    titleSource: 'ai'
  })
  assert.deepEqual(proposeTitle({ title: 'Fix login', titleSource: 'ai' }, { title: '#2 · y', source: 'issue' }), {
    title: '#2 · y',
    titleSource: 'issue'
  })
})

test('issue title format matches spec', () => {
  assert.equal(issueTitle({ issueNumber: 142, issueTitle: 'Login redirect loops on Safari' }), '#142 · Login redirect loops on Safari')
})

test('sanitizeTitle strips quotes and punctuation, clamps length', () => {
  assert.equal(sanitizeTitle('"Fix Safari login redirect."'), 'Fix Safari login redirect')
  assert.equal(sanitizeTitle('  fix the build\nsecond line'), 'Fix the build')
  assert.ok(sanitizeTitle('x'.repeat(200)).length <= 64)
})

test('heuristicTitle takes leading words and skips code fences', () => {
  assert.equal(heuristicTitle('fix the flaky auth test in CI'), 'Fix the flaky auth test in CI')
  assert.ok(heuristicTitle('```js\ncode\n```\nrename the user model') !== '')
})
