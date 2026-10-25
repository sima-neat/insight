import { TestBed } from '@angular/core/testing';
import { StatsSession } from './stats-session';

describe('StatsSession', () => {
  it('drops the runs ticked and selected when the board changes, and keeps them on the same one', () => {
    const session = TestBed.inject(StatsSession);
    session.card.set('board-power');
    session.compareSeries.set('thermal_max');
    session.followBoard(3);
    session.run.set('a');
    session.checkedRuns.set(['a', 'b']);

    session.followBoard(3);
    expect(session.run()).toBe('a');
    expect(session.checkedRuns()).toEqual(['a', 'b']);

    session.followBoard(4);
    expect(session.run()).toBeNull();
    expect(session.checkedRuns()).toEqual([]);
    // Where the user was on Live, and the series Compare draws, are not about the board's runs.
    expect(session.card()).toBe('board-power');
    expect(session.compareSeries()).toBe('thermal_max');
  });
});
