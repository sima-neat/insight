import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { CameraId } from './camera-id';

describe('CameraId', () => {
  let fixture: ComponentFixture<CameraId>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(CameraId);
    fixture.componentRef.setInput('name', 'imx477 5-001a');
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  const trigger = (): HTMLButtonElement => fixture.nativeElement.querySelector('button');
  const panel = (): HTMLElement | null =>
    document.querySelector('[role="dialog"][aria-label="Camera ID"]');

  it('is a button that opens the ID with what it is for and a Copy button named after it', async () => {
    expect(trigger().textContent?.trim()).toBe('Camera ID');
    expect(panel()).toBeNull();
    trigger().click();
    await fixture.whenStable();
    expect(panel()!.textContent).toContain('The ID a Neat application opens this camera by.');
    expect(panel()!.querySelector('neat-code-block code')?.textContent?.trim()).toBe(
      'imx477 5-001a',
    );
    expect(
      [...panel()!.querySelectorAll('button')].some((b) => b.textContent?.includes('Copy')),
    ).toBe(true);
  });

  it('folds on Escape', async () => {
    trigger().click();
    await fixture.whenStable();
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(panel()).toBeNull();
  });
});
