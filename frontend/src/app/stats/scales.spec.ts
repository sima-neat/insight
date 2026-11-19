import { THERMAL_SCALE, niceCeil, powerCeiling, scaleFor } from './scales';

describe('scales', () => {
  it('scales stay fixed: percentages 0-100, temperatures 40-90, the rest a round number above the peak', () => {
    expect(THERMAL_SCALE).toEqual([40, 90]);
    expect(scaleFor('%', [[12, 99]])).toEqual([0, 100]);
    expect(scaleFor('C', [[66.8, 68.6]])).toEqual([40, 90]);
    // A reading outside the band widens it.
    expect(scaleFor('C', [[35, 96.2]])).toEqual([30, 100]);
    // Every spelling the Thermal section counts as a temperature gets the same shared scale.
    for (const unit of ['°C', 'degC', 'deg C', 'celsius', ' Celsius ']) {
      expect(scaleFor(unit, [[66.8, 68.6]]), unit).toEqual([40, 90]);
    }
    expect(scaleFor('W', [[10.2, 16.69]])).toEqual([0, 20]);
    expect(scaleFor('MB', [[742.3]])).toEqual([0, 1000]);
    // A known capacity is the ceiling.
    expect(scaleFor('MB', [[520.7]], 1788)).toEqual([0, 1788]);
    expect(scaleFor('MB/s', [[null, null]])).toEqual([0, 1]);
    expect(scaleFor(null, [])).toEqual([0, 1]);
    expect([0.37, 18.36, 816, 3.4, 0].map(niceCeil)).toEqual([0.4, 20, 1000, 4, 1]);
  });

  it('a percentage scale widens to a round number above a value past 100: 130 → [0, 150]', () => {
    expect(scaleFor('%', [[40, 130]])).toEqual([0, 150]);
    expect(scaleFor('%', [[null], [100]])).toEqual([0, 100]);
    expect(scaleFor('%', [[101]])).toEqual([0, 120]);
  });

  it('a value just above a round number goes to the next one, and a bad value reads as 1', () => {
    expect([1, 1.01, 8, 8.1, 10, 100.5].map(niceCeil)).toEqual([1, 1.2, 8, 10, 10, 120]);
    expect([Number.NaN, -5].map(niceCeil)).toEqual([1, 1]);
  });

  it('the power ceiling is a round number above the highest reading, or none without one', () => {
    expect(powerCeiling([10.2, null, 16.69, 12])).toBe(20);
    expect(powerCeiling([100])).toBe(120);
    expect(powerCeiling([null, null])).toBeNull();
    expect(powerCeiling([])).toBeNull();
  });
});
