import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { diffLines } from '../src/shared/diff'

test('single-line replacement with context', () => {
  const d = diffLines('a\nb\nc', 'a\nB\nc')
  assert.deepEqual(d, [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'B' },
    { kind: 'same', text: 'c' }
  ])
})

test('pure addition', () => {
  const d = diffLines('a\nc', 'a\nb\nc')
  assert.deepEqual(d, [
    { kind: 'same', text: 'a' },
    { kind: 'add', text: 'b' },
    { kind: 'same', text: 'c' }
  ])
})

test('identical input produces no change rows', () => {
  assert.equal(diffLines('x\ny', 'x\ny').filter((l) => l.kind !== 'same').length, 0)
})
