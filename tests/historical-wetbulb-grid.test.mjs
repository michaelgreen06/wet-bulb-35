import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { historyBucketKey, historyGroupKey, mapEra5LandCell } from '../lib/historical-wetbulb/grid.mjs';

const grid = fileURLToPath(new URL('../scripts/historical-wetbulb/era5land_grid.py', import.meta.url));

test('matches metadata-resolved ARCO cells, grid indices and 4×8 tiles', () => {
  // From the authenticated ARCO axes (map_arco_cohort.py), Top-50 cohort.
  for (const [coordinate, cell, index, tile, tie] of [
    [[13.08784, 80.27847], [13.1, 80.3], [1031, 2602], [257, 325], false],
    [[29.76328, -95.36327], [29.8, -95.4], [1198, 845], [299, 105], false],
    [[-6.21462, 106.84513], [-6.2, 106.8], [838, 2867], [209, 358], false],
    [[23.11667, 113.25], [23.1, 113.3], [1131, 2932], [282, 366], true],
  ]) {
    assert.deepEqual(mapEra5LandCell(...coordinate), { cell, gridIndex: index, tile, tie });
  }
});

test('half-cell ties go north/east in every hemisphere; the antimeridian wraps', () => {
  assert.deepEqual(mapEra5LandCell(12.35, 1).cell, [12.4, 1]);
  assert.deepEqual(mapEra5LandCell(-12.35, 1).cell, [-12.3, 1]);
  assert.deepEqual(mapEra5LandCell(1, -12.25).cell, [1, -12.2]);
  assert.deepEqual(mapEra5LandCell(0, -180).cell, [0, 180]);
  assert.deepEqual(mapEra5LandCell(0, -179.96).cell, [0, 180]);
  assert.deepEqual(mapEra5LandCell(0, -179.94).cell, [0, -179.9]);
  assert.deepEqual(mapEra5LandCell(90, 0).gridIndex, [1800, 1799]);
  assert.throws(() => mapEra5LandCell(91, 0), /Invalid/);
  assert.throws(() => mapEra5LandCell(Number.NaN, 0), /Invalid/);
});

test('JS Worker mapping equals the Python planner on deterministic random and tie coordinates', () => {
  let seed = 20261004;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const points = Array.from({ length: 400 }, () => [Number((next() * 180 - 90).toFixed(5)), Number((next() * 360 - 180).toFixed(5))]);
  for (let i = 0; i < 100; i++) points.push([Number(((Math.floor(next() * 1700) - 850) / 10 + 0.05).toFixed(2)), Number(((Math.floor(next() * 3500) - 1750) / 10 + 0.05).toFixed(2))]);
  const script = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('g',sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)\nprint(json.dumps([g.map_coordinate(a,b) for a,b in json.loads(sys.stdin.read())]))`;
  const python = JSON.parse(execFileSync('python3', ['-c', script, grid], { input: JSON.stringify(points) }));
  points.forEach((point, i) => assert.deepEqual(mapEra5LandCell(...point), python[i], `${point}`));
});

test('group and 2° bucket keys are stable', () => {
  assert.equal(historyGroupKey([-6.2, 106.8], 'Asia/Jakarta'), '-6.2,106.8|Asia/Jakarta');
  assert.equal(historyBucketKey([-6.2, 106.8]), 's8e106');
  assert.equal(historyBucketKey([29.8, -95.4]), 'n28w96');
  assert.equal(historyBucketKey([0, 0]), 'n0e0');
});
