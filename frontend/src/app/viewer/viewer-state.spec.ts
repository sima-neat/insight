import { signal } from '@angular/core';
import { convertToParamMap } from '@angular/router';
import {
  MAX_CHANNELS,
  normalizeMaxChannels,
  parseChannelIndices,
  readViewerParams,
  ViewerState,
} from './viewer-state';

const range = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => from + index);

// Ported from 829ec7c's viewerLayout.test.js. Its page-size presets and column rules are gone
// (the size slider and the packing grid replace them), so only the channel and capacity rules
// remain; src order is now kept instead of sorted.
describe('channel parsing (ported)', () => {
  it('viewer exposes all 80 channels', () => {
    expect(MAX_CHANNELS).toBe(80);
  });

  it('configured SDK capacity limits channel selection', () => {
    expect(normalizeMaxChannels('4')).toBe(4);
    expect(parseChannelIndices(null, 4)).toEqual([0, 1, 2, 3]);
    expect(parseChannelIndices('', 4)).toEqual([]);
    expect(parseChannelIndices('3,4,79,bad,0,3', 4)).toEqual([3, 0]);
  });

  it('missing or invalid capacity preserves the legacy eighty-channel behavior', () => {
    for (const value of [null, '', 'bad', '4channels', '0', '81']) {
      expect(normalizeMaxChannels(value)).toBe(80);
    }
    expect(parseChannelIndices(null)).toHaveLength(80);
  });

  it('keeps the src order, dropping repeats after their first appearance', () => {
    expect(parseChannelIndices('9,3,1,3,9', 16)).toEqual([9, 3, 1]);
  });
});

describe('readViewerParams', () => {
  const read = (query: Record<string, string>) => readViewerParams(convertToParamMap(query));

  it('reads nothing from an empty query', () => {
    expect(read({})).toStrictEqual({ src: null, maxChannels: null, mode: null, debug: false });
  });

  it('reads src as given, max_channels normalized, mode and debug=1', () => {
    expect(read({ src: '3,1', max_channels: '4', mode: 'dark', debug: '1' })).toStrictEqual({
      src: '3,1',
      maxChannels: 4,
      mode: 'dark',
      debug: true,
    });
  });

  it('an invalid max_channels means all 80, as before; an unknown mode or debug value is ignored', () => {
    expect(read({ max_channels: '0', mode: 'Dark', debug: 'true' })).toStrictEqual({
      src: null,
      maxChannels: 80,
      mode: null,
      debug: false,
    });
  });
});

describe('ViewerState', () => {
  function create(channels: readonly number[] = range(16)) {
    const list = signal(channels);
    return { list, state: new ViewerState(list) };
  }

  it('shows no channel until the grid reports how many fit', () => {
    const { state } = create();

    expect(state.pageChannels()).toEqual([]);
    expect(state.pageCount()).toBe(1);
  });

  it('slices the channels into pages of perPage', () => {
    const { state } = create();
    state.perPage.set(6);

    expect(state.pageCount()).toBe(3);
    expect(state.pageChannels()).toEqual(range(6));
    state.next();
    expect(state.pageChannels()).toEqual(range(6, 6));
    state.next();
    expect(state.pageChannels()).toEqual([12, 13, 14, 15]);
  });

  it('stops paging at either end', () => {
    const { state } = create();
    state.perPage.set(6);

    state.previous();
    expect(state.page()).toBe(0);
    state.goToPage(3);
    state.next();
    expect(state.page()).toBe(2);
  });

  it('goToPage takes a 1-based page, clamps it into range and ignores a non-integer', () => {
    const { state } = create();
    state.perPage.set(6);

    state.goToPage(2);
    expect(state.page()).toBe(1);
    state.goToPage(99);
    expect(state.page()).toBe(2);
    state.goToPage(-4);
    expect(state.page()).toBe(0);
    state.goToPage(Number.NaN);
    expect(state.page()).toBe(0);
  });

  it('clamps the page when perPage grows or the channel list shrinks', () => {
    const { list, state } = create();
    state.perPage.set(6);
    state.goToPage(3);

    state.perPage.set(8);
    expect(state.page()).toBe(1);

    list.set(range(4));
    expect(state.page()).toBe(0);
    expect(state.pageChannels()).toEqual(range(4));
  });

  it('keeps a selected channel that was on screen on screen when perPage changes', () => {
    const { state } = create();
    state.perPage.set(6);
    state.goToPage(2);
    state.select(10);

    state.perPage.set(4);
    expect(state.pageChannels()).toContain(10);
    expect(state.page()).toBe(2);

    state.perPage.set(2);
    expect(state.pageChannels()).toEqual([10, 11]);
  });

  it('does not pull the user back to a selected channel they paged away from', () => {
    const { state } = create();
    state.perPage.set(6);
    state.select(1);
    state.goToPage(3);

    state.perPage.set(4);
    expect(state.page()).toBe(2);
    expect(state.pageChannels()).not.toContain(1);
  });

  it('jumps to the page holding a channel and selects it; an absent channel changes nothing', () => {
    const { state } = create([9, 3, 1, 7, 5, 2, 8]);
    state.perPage.set(3);

    expect(state.jumpToChannel(5)).toBe(true);
    expect(state.page()).toBe(1);
    expect(state.selected()).toBe(5);

    expect(state.jumpToChannel(4)).toBe(false);
    expect(state.page()).toBe(1);
    expect(state.selected()).toBe(5);
  });

  it('selects and clears the selection', () => {
    const { state } = create();

    state.select(3);
    expect(state.selected()).toBe(3);
    state.clearSelection();
    expect(state.selected()).toBeNull();
  });
});
