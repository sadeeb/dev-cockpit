import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseIssueRefs, repoFromRemoteUrl } from '../src/shared/issueRefs'

test('parses bare #123', () => {
  assert.deepEqual(parseIssueRefs('fix #123 please'), [{ repo: null, number: 123 }])
})

test('parses owner/repo#123', () => {
  assert.deepEqual(parseIssueRefs('see acme/web-app#42'), [{ repo: 'acme/web-app', number: 42 }])
})

test('parses issue and PR URLs', () => {
  assert.deepEqual(parseIssueRefs('https://github.com/acme/web.app/issues/7'), [
    { repo: 'acme/web.app', number: 7 }
  ])
  assert.deepEqual(parseIssueRefs('https://github.com/a-b/c_d/pull/991'), [
    { repo: 'a-b/c_d', number: 991 }
  ])
})

test('dedupes and keeps order, URL first', () => {
  const refs = parseIssueRefs('https://github.com/x/y/issues/5 also x/y#5 and #9')
  assert.deepEqual(refs, [
    { repo: 'x/y', number: 5 },
    { repo: null, number: 9 }
  ])
})

test('ignores markdown headings and code', () => {
  assert.deepEqual(parseIssueRefs('# Heading\nuse arr[1]'), [])
  assert.deepEqual(parseIssueRefs('color #fff and #123abc'), [])
})

test('repoFromRemoteUrl handles ssh and https forms', () => {
  assert.equal(repoFromRemoteUrl('git@github.com:acme/web.git'), 'acme/web')
  assert.equal(repoFromRemoteUrl('https://github.com/acme/web.git'), 'acme/web')
  assert.equal(repoFromRemoteUrl('https://github.com/acme/web'), 'acme/web')
  assert.equal(repoFromRemoteUrl('https://gitlab.com/acme/web.git'), null)
})
