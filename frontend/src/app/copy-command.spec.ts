import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { CopyCommand } from './copy-command';

@Component({
  imports: [CopyCommand],
  template: `<app-copy-command [command]="command()" label="ssh command" />`,
})
class Host {
  readonly command = signal('ssh -p 2222 sima@10.0.0.5');
}

describe('CopyCommand', () => {
  let fixture: ComponentFixture<Host>;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let writeText: ReturnType<typeof vi.fn>;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(async () => {
    toasts = { status: vi.fn(), error: vi.fn() };
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    TestBed.configureTestingModule({ providers: [{ provide: NeatToasts, useValue: toasts }] });
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  afterEach(() => {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const copy = () => root().querySelector<HTMLButtonElement>('button')!;

  it('shows the command with Copy, named for what it copies', () => {
    expect(root().querySelector('code[neatCode]')?.textContent).toBe('ssh -p 2222 sima@10.0.0.5');
    expect(copy().textContent?.trim()).toBe('Copy');
    expect(copy().getAttribute('aria-label')).toBe('Copy the ssh command');
  });

  it('copies the command as it is now and says so', async () => {
    fixture.componentInstance.command.set('ssh sima@192.168.1.20');
    await settle();
    copy().click();
    await settle();
    expect(writeText).toHaveBeenCalledWith('ssh sima@192.168.1.20');
    expect(toasts.status).toHaveBeenCalledWith('Copied: ssh sima@192.168.1.20');
  });

  it('a refused clipboard says how to copy it instead', async () => {
    writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    copy().click();
    await settle();
    expect(toasts.status).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      'Could not copy: the browser only allows clipboard access over HTTPS or localhost. Select the text and copy it instead.',
    );
  });
});
