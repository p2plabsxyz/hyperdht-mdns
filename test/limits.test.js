'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Counter, RateLimiter } = require('../src/limits')

test('a rate limiter allows a burst, then refills at its rate', () => {
  let now = 0
  const limiter = new RateLimiter({ rate: 2, burst: 4, now: () => now })

  for (let i = 0; i < 4; i++) assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), false)
  // Another key has a bucket of its own.
  assert.equal(limiter.take('b'), true)

  now += 500
  assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), false)

  now += 10_000
  for (let i = 0; i < 4; i++) assert.equal(limiter.take('a'), true)
  assert.equal(limiter.take('a'), false)
})

test('a sender spraying from many keys cannot grow the table past its size', () => {
  const limiter = new RateLimiter({ rate: 1, burst: 1, maxKeys: 100 })
  for (let i = 0; i < 10_000; i++) limiter.take(`10.0.${i >> 8}.${i & 255}`)
  assert.equal(limiter._buckets.size, 100)
})

test('a counter counts per key and forgets empty keys', () => {
  const counter = new Counter()
  counter.add('a')
  counter.add('a')
  counter.add('b')
  assert.equal(counter.get('a'), 2)
  counter.remove('a')
  counter.remove('a')
  counter.remove('a')
  assert.equal(counter.get('a'), 0)
  assert.equal(counter._counts.has('a'), false)
  assert.equal(counter.get('b'), 1)
})
