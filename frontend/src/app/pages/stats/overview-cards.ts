import type { NeatTone } from '@sima/neat-ui';
import {
  alertLabel,
  formatNumber,
  isNumber,
  isThermalMetric,
  metricAlert,
  statusLabel,
  unitSuffix,
} from '../../stats/format';
import {
  boardPowerChart,
  cardReported,
  cardShown,
  currentTotal,
  metricByKey,
  metricChart,
  networkChart,
  OVERVIEW_CARDS,
  thermalMax,
  thermalMaxChart,
  type OverviewCard,
  type TelemetryWindow,
} from '../../stats/telemetry';
import type { StatsChartInputs } from './stats-chart';

/** One overview card as the page shows it. */
export interface OverviewCardView {
  readonly card: OverviewCard;
  /** The current reading, worded: "37.5", "—" for one not taken, "Not reported". */
  readonly value: string;
  /** The reading's unit after it; '' when there is no reading. */
  readonly unit: string;
  readonly caption: string;
  /** How far past its thresholds the card's metric is; null while within them. */
  readonly chip: { label: string; tone: NeatTone } | null;
  /** Null while the card's metric is not reported: "Not reported" stands in for the chart. */
  readonly chart: StatsChartInputs | null;
}

/**
 * The overview cards the board can fill, in #170's order: a card shows while its area has metrics
 * (`cardShown`), and says "Not reported" while its own are not (`cardReported`). The charts are the
 * side panel's builders, so a card and its area never disagree about scale or thresholds.
 */
export function overviewCards(window: TelemetryWindow): OverviewCardView[] {
  return OVERVIEW_CARDS.filter((card) => cardShown(window, card)).map((card) =>
    cardReported(window, card)
      ? reportedCard(window, card)
      : { card, value: 'Not reported', unit: '', caption: '', chip: null, chart: null },
  );
}

function reportedCard(window: TelemetryWindow, card: OverviewCard): OverviewCardView {
  if (card.id === 'thermal-max') {
    // Reported means the board has a temperature, so there is a thermal max.
    const { hottest } = thermalMax(window)!;
    const alert = metricAlert(window.metrics.filter(isThermalMetric));
    return {
      card,
      ...reading(hottest?.value ?? null, 'C'),
      caption: hottest ? `Hottest sensor: ${hottest.group} ${hottest.short || hottest.label}` : '',
      chip: alert && alertLabel(alert),
      chart: thermalMaxChart(window),
    };
  }
  const metrics = card.keys.flatMap((key) => metricByKey(window, key) ?? []);
  // A pair (Network) has the worse status of its two, and its total only while both are read.
  const alert = metricAlert(metrics);
  const value =
    card.id === 'network'
      ? currentTotal(card.keys.map((key) => metricByKey(window, key)?.value ?? null))
      : metrics[0].value;
  return {
    card,
    ...reading(value, metrics[0].unit),
    caption: '',
    chip: alert && statusLabel(alert.tone),
    chart: chartOf(window, card),
  };
}

function chartOf(window: TelemetryWindow, card: OverviewCard): StatsChartInputs | null {
  switch (card.id) {
    case 'board-power':
      return boardPowerChart(window);
    case 'network':
      return networkChart(window);
    default:
      return metricChart(window, card.keys[0]);
  }
}

/** A reading as a card's value and unit; an em dash and no unit for one not taken. */
function reading(value: number | null, unit: string | null): { value: string; unit: string } {
  return isNumber(value)
    ? { value: formatNumber(value), unit: unitSuffix(unit) }
    : { value: '—', unit: '' };
}
