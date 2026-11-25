import { isNumber, isTemperatureUnit } from './format';

/** Temperatures share one band, as Sentinel's thermal charts do, so sensors compare at a glance. */
export const THERMAL_SCALE = [40, 90] as const;

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest round number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten) at or above `value`. */
export function niceCeil(value: number): number {
  if (!isNumber(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  // The tolerance keeps a value that is a round number up to float error (1.2 × 100) on it.
  const step = NICE_STEPS.find((candidate) => candidate * power >= value - power * 1e-9) ?? 10;
  return Number((step * power).toPrecision(6));
}

/**
 * The [min, max] a chart of `unit` draws in. Percentages read 0 to 100 and temperatures 40 to 90,
 * so every chart of one kind compares at a glance; a reading outside the band widens it (a
 * percentage past 100 to a round number above it, a temperature to the next ten). Any other unit
 * gets `ceiling` when its capacity is known, else a round number above its peak.
 */
export function scaleFor(
  unit: string | null,
  valueLists: readonly (readonly (number | null)[])[],
  ceiling: number | null = null,
): readonly [number, number] {
  const values = valueLists.flat().filter(isNumber);
  const peak = values.length ? Math.max(...values) : 0;
  if ((unit ?? '').trim() === '%') return [0, peak > 100 ? niceCeil(peak) : 100];
  if (isTemperatureUnit(unit)) {
    const [low, high] = THERMAL_SCALE;
    return [
      Math.min(low, ...values.map((value) => Math.floor(value / 10) * 10)),
      Math.max(high, ...values.map((value) => Math.ceil(value / 10) * 10)),
    ];
  }
  if (isNumber(ceiling) && ceiling > 0) return [0, ceiling];
  return [0, niceCeil(peak * 1.1)];
}

/**
 * The ceiling the power charts share, so the current, average and peak read on one scale: a round
 * number above the highest reading with a tenth to spare; null when there is no reading.
 */
export function powerCeiling(values: readonly (number | null)[]): number | null {
  const readings = values.filter(isNumber);
  return readings.length ? niceCeil(Math.max(...readings) * 1.1) : null;
}
