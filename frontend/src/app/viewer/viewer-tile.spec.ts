import { Component, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatStatusChipButton } from '@sima/neat-ui/status-chip';
import { bufferSettleMs, type NeatFrameStats, NeatVideoTile } from '@sima/neat-ui/video';
import { ChannelLateness } from './channel-lateness';
import { ChannelPlayback } from './channel-playback';
import { FakeConnections } from './fake-connections.testing';
import { FakeLocalStorage } from '../fake-storage.testing';
import { RoiStore } from './settings/roi-store';
import { ViewerSettingsStore } from './settings/viewer-settings.store';
import { VfConnections } from './vf/vf-connections';
import { ViewerTile } from './viewer-tile';

class NoopResizeObserver {
  observe(): void {
    // The kit tile sizes its canvas from this; these specs draw nothing.
  }
  disconnect(): void {
    // Nothing observed.
  }
}

const FRAME_STATS: NeatFrameStats = {
  timestampMatches: 10,
  arrivalFallbacks: 0,
  frameMisses: 0,
  expired: 0,
  evicted: 0,
  untimestampedReceived: 0,
  late: 0,
  timestampedPending: 0,
  arrivalPending: 0,
  recentLatenessMedianMs: null,
  recentLatenessMaxMs: null,
  metadataMessagesPerSecond: 15,
  video: {
    readyState: 4,
    paused: false,
    currentTime: 1.5,
    videoWidth: 640,
    videoHeight: 480,
    lastFrameAgeMs: 20,
    active: true,
  },
};

@Component({
  imports: [ViewerTile],
  template: `
    @if (shown()) {
      <app-viewer-tile
        [channel]="channel()"
        [bars]="bars()"
        [selected]="false"
        (lateNotice)="lateNotices = lateNotices + 1"
      />
    }
  `,
})
class Host {
  readonly store = inject(ViewerSettingsStore);
  readonly channel = signal(2);
  readonly bars = signal(true);
  readonly shown = signal(true);
  lateNotices = 0;
}

describe('ViewerTile', () => {
  let fake: FakeConnections;
  let fixture: ComponentFixture<Host>;
  let now: number;

  beforeEach(async () => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    fake = new FakeConnections();
    TestBed.configureTestingModule({
      providers: [
        { provide: VfConnections, useValue: fake.asVfConnections() },
        RoiStore,
        ViewerSettingsStore,
        ChannelLateness,
        ChannelPlayback,
      ],
    });
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const host = () => fixture.componentInstance;
  const connection = () => fake.connections.get(2)!;
  const kitTile = (): NeatVideoTile =>
    fixture.debugElement.query(By.directive(NeatVideoTile)).componentInstance;
  const text = (selector: string) =>
    (fixture.nativeElement as HTMLElement).querySelector(selector)?.textContent?.trim() ?? null;
  const chip = (): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector('button[neatTileChip]');

  /** The kit tile's lateness window reports `share`; returns the reset spy. */
  function lateShare(share: number | null) {
    vi.spyOn(kitTile(), 'snapshot').mockReturnValue({
      ...kitTile().snapshot(),
      recentLateShare: share,
    });
    return vi.spyOn(kitTile(), 'resetLatenessWindow');
  }

  async function tick(): Promise<void> {
    kitTile().frameStats.emit(FRAME_STATS);
    await fixture.whenStable();
  }

  async function play(): Promise<void> {
    kitTile().stateChange.emit('playing');
    await fixture.whenStable();
  }

  it('holds its channel’s connection while it exists and releases it when removed', async () => {
    expect(fake.held()).toEqual([2]);
    expect(kitTile().source()).toBe(connection());

    host().shown.set(false);
    await fixture.whenStable();

    expect(fake.held()).toEqual([]);
    expect(fake.released).toEqual([2]);
  });

  it('labels the tile with its channel number and the connection’s status line', async () => {
    expect(text('.label')).toBe('2');

    connection().status.set({
      phase: 'connected',
      codec: 'H.264',
      width: 640,
      height: 480,
      fps: 15,
      kbps: 812.4,
      messagesPerSecond: 15,
    });
    await fixture.whenStable();

    expect(text('.status')).toBe('H.264 · 640×480 · 15.0 fps · 812.4 kb/s · 15 msg/s');
  });

  it('applies the channel’s sync buffer to the connection and its retention to the tile, each only when it changes', async () => {
    expect(connection().syncBuffers).toEqual([300]);
    expect(kitTile().retentionMs()).toBe(0);

    host().store.set(2, 'general.videoSyncBufferMs', 500);
    await fixture.whenStable();
    expect(connection().syncBuffers).toEqual([300, 500]);

    host().store.set('global', 'general.metadataRetentionMs', 2000);
    await fixture.whenStable();
    expect(connection().syncBuffers).toEqual([300, 500]);
    expect(kitTile().retentionMs()).toBe(2000);

    // An overlay setting changes the tile's settings, not the connection.
    host().store.set(2, 'general.lineWidth', 4);
    await fixture.whenStable();
    expect(connection().syncBuffers).toEqual([300, 500]);
    expect(kitTile().settings().general.lineWidth).toBe(4);
  });

  it('hands the tile’s frame stats to the connection', async () => {
    await tick();

    expect(connection().frameStats).toEqual([FRAME_STATS]);
  });

  it('shows "Metadata late" while lateness is on and the tile plays; the chip asks for the notice', async () => {
    lateShare(0.6);
    await tick();
    // Not playing yet: nothing to be late for.
    expect(chip()).toBeNull();

    await play();
    expect(chip()?.textContent?.trim()).toBe('Metadata late');
    // The kit's status chip, as a button, in the warning tone of any warning.
    const kitChip = fixture.debugElement.query(By.directive(NeatStatusChipButton));
    expect(kitChip.nativeElement).toBe(chip());
    expect(kitChip.injector.get(NeatStatusChipButton).tone()).toBe('warning');

    chip()!.click();
    expect(host().lateNotices).toBe(1);

    kitTile().stateChange.emit('stopped');
    await fixture.whenStable();
    expect(chip()).toBeNull();
  });

  it('a sync buffer change resets the lateness window and holds the chip back while it settles', async () => {
    await play();
    const reset = lateShare(0.9);
    await tick();
    expect(chip()).not.toBeNull();

    host().store.set(2, 'general.videoSyncBufferMs', 700);
    await fixture.whenStable();
    expect(reset).toHaveBeenCalledOnce();
    expect(chip()).toBeNull();

    now += bufferSettleMs(300, 700) - 1;
    await tick();
    expect(chip()).toBeNull();
    expect(reset).toHaveBeenCalledTimes(2);

    now += 1;
    await tick();
    expect(chip()).not.toBeNull();
  });

  it('with bars off shows no label, status or chip', async () => {
    await play();
    lateShare(0.9);
    await tick();

    host().bars.set(false);
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.bar')).toBeNull();
    expect(chip()).toBeNull();
  });

  it('publishes its lateness each tick for the inspector, and withdraws it when removed', async () => {
    const reading = TestBed.inject(ChannelLateness).of(2);
    expect(reading()).toEqual({ active: false, snapshot: null });

    vi.spyOn(kitTile(), 'snapshot').mockReturnValue({
      ...kitTile().snapshot(),
      recentLateShare: 0.9,
      recentLatenessMedianMs: 80,
      recentLatenessP90Ms: 120,
    });
    await tick();
    // Late, but not playing: the warning is off, the measurement is there.
    expect(reading()).toMatchObject({
      active: false,
      snapshot: { recentLateShare: 0.9, recentLatenessMedianMs: 80, recentLatenessP90Ms: 120 },
    });

    await play();
    expect(reading()?.active).toBe(true);

    // A buffer change turns the warning off at once, as it does the chip.
    host().store.set(2, 'general.videoSyncBufferMs', 700);
    await fixture.whenStable();
    expect(reading()?.active).toBe(false);

    kitTile().stateChange.emit('empty');
    await fixture.whenStable();
    expect(reading()).toEqual({ active: false, snapshot: null });

    host().shown.set(false);
    await fixture.whenStable();
    expect(reading()).toBeNull();
  });

  it('publishes whether it plays for the inspector, and withdraws it when removed', async () => {
    const playing = TestBed.inject(ChannelPlayback).of(2);
    expect(playing()).toBe(false);

    await play();
    expect(playing()).toBe(true);

    kitTile().stateChange.emit('stopped');
    await fixture.whenStable();
    expect(playing()).toBe(false);

    await play();
    host().shown.set(false);
    await fixture.whenStable();
    expect(playing()).toBe(false);
  });
});
