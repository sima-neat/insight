import assert from 'node:assert/strict'
import test from 'node:test'

// Deliberate failure to show the Unit tests job fails CI (#152). Removed in the next commit.
test('deliberate failure', () => assert.equal(1, 2))
