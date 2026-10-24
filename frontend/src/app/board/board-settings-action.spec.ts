import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatCallout } from '@sima/neat-ui/callout';
import { TopBarDialogs } from '../top-bar-dialogs';
import { BoardSettingsAction } from './board-settings-action';

@Component({
  imports: [BoardSettingsAction, NeatCallout],
  template: `
    <neat-callout tone="danger" heading="Scan failed">
      <app-board-settings-action neatCalloutActions />
    </neat-callout>
  `,
})
class Host {}

describe('BoardSettingsAction', () => {
  it("is a callout's Open board settings, which opens the board dialog", async () => {
    const dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({ providers: [{ provide: TopBarDialogs, useValue: dialogs }] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-slot="callout-actions"] app-board-settings-action button',
    );
    expect(button.textContent!.trim()).toBe('Open board settings');
    expect(button.type).toBe('button');
    button.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
  });
});
