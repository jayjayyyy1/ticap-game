const assert = require('node:assert/strict');
const { GAME_CONFIG, pickSymbol, createOutcome, scoreOutcome } = require('../script.js');
const boardFromRows = rows => Array.from({ length: 5 }, (_, c) => rows.map(row => row[c]));
const blank = () => [
  ['sun', 'tree', 'house', 'battery', 'wind'],
  ['panel', 'sun', 'tree', 'house', 'battery'],
  ['tree', 'house', 'battery', 'wind', 'panel']
];

assert.equal(scoreOutcome(boardFromRows(blank())).total, 0);
for (const [length, prize] of [[3, 50], [4, 150], [5, 500]]) {
  const rows = blank();
  rows[0] = Array.from({ length: 5 }, (_, i) => i < length ? 'sun' : 'tree');
  const result = scoreOutcome(boardFromRows(rows));
  assert.equal(result.total, prize, `${length} symbols pay only the longest prize`);
  assert.equal(result.lines[0].length, length);
  assert.equal(result.lines[0].row, 0);
}
const shifted = blank();
shifted[1] = ['panel', 'sun', 'sun', 'sun', 'sun'];
assert.equal(scoreOutcome(boardFromRows(shifted)).total, 0, 'matches must begin at leftmost reel');
const broken = blank();
broken[2] = ['tree', 'tree', 'sun', 'tree', 'tree'];
assert.equal(scoreOutcome(boardFromRows(broken)).total, 0, 'matches must be consecutive');
const jackpotRows = blank();
jackpotRows[0] = Array(5).fill('panel');
const jackpot = scoreOutcome(boardFromRows(jackpotRows));
assert.equal(jackpot.total, 1000, 'solar jackpot replaces normal award');
assert.equal(jackpot.jackpot, true);
const multiple = [Array(5).fill('panel'), ['sun', 'sun', 'sun', 'tree', 'tree'], ['tree', 'tree', 'tree', 'tree', 'sun']];
assert.equal(scoreOutcome(boardFromRows(multiple)).total, 1200, 'all three lines pay independently');
assert.deepEqual(scoreOutcome(boardFromRows(multiple)).lines.map(x => x.points), [1000, 50, 150]);
assert.equal(scoreOutcome(Array.from({ length: 5 }, () => Array(3).fill('panel'))).total, 3000);
assert.equal(pickSymbol(() => 0), 'panel');
assert.equal(pickSymbol(() => .139999), 'panel');
assert.equal(pickSymbol(() => .14), 'sun');
assert.equal(pickSymbol(() => .999999), 'wind');
assert.equal(GAME_CONFIG.spins, 5);
let calls = 0;
const outcome = createOutcome(() => { calls++; return .2; });
assert.equal(calls, 15);
assert.deepEqual(outcome, Array.from({ length: 5 }, () => Array(3).fill('sun')));
for (let i = 0; i < 1000; i++) {
  const result = createOutcome();
  assert.equal(result.length, 5);
  result.forEach(column => {
    assert.equal(column.length, 3);
    column.forEach(symbol => assert.ok(GAME_CONFIG.symbols.some(s => s.id === symbol)));
  });
}
console.log('Rules passed: prizes, longest match, leftmost/consecutive rules, independent lines, jackpot, weighted boundaries, and 1,000 random boards.');
