import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { filePreview, type FilePreview, PreviewFrame, type PreviewStream } from './preview-frame';

describe('filePreview', () => {
  it('previews MJPEG through the server’s MJPEG route, by codec or by extension', () => {
    expect(filePreview('clips/cam 1.avi', true)).toEqual({
      kind: 'image',
      src: '/api/media-preview/mjpeg?path=clips%2Fcam%201.avi',
      path: 'clips/cam 1.avi',
    });
    expect(filePreview('clips/cam.MJPG', false)?.src).toBe(
      '/api/media-preview/mjpeg?path=clips%2Fcam.MJPG',
    );
    // The streamer reads a JPEG as MJPEG, so a slot's still goes through the same route.
    expect(filePreview('stills/a.jpg', true)?.src).toBe(
      '/api/media-preview/mjpeg?path=stills%2Fa.jpg',
    );
  });

  it('serves a video or an image as itself, each path segment encoded', () => {
    expect(filePreview('people/walk 1.mp4', false)).toEqual({
      kind: 'video',
      src: '/media/people/walk%201.mp4',
      path: 'people/walk 1.mp4',
    });
    for (const extension of ['mov', 'avi', 'mkv', 'webm']) {
      expect(filePreview(`a.${extension}`, false)?.kind).toBe('video');
    }
    expect(filePreview('stills/b.PNG', false)).toEqual({
      kind: 'image',
      src: '/media/stills/b.PNG',
      path: 'stills/b.PNG',
    });
    expect(filePreview('stills/a.jpeg', false)?.src).toBe('/media/stills/a.jpeg');
  });

  it('has nothing to show for any other file', () => {
    expect(filePreview('notes.txt', false)).toBeNull();
    expect(filePreview('archive', false)).toBeNull();
    expect(filePreview('', false)).toBeNull();
  });
});

@Component({
  imports: [PreviewFrame],
  template: `@if (shown()) {
    <app-preview-frame [file]="file()" [stream]="stream()" (streamError)="streamErrors = streamErrors + 1"
      ><p class="projected">Nothing to show</p></app-preview-frame
    >
  }`,
})
class Host {
  readonly shown = signal(true);
  readonly file = signal<FilePreview | null>(null);
  readonly stream = signal<PreviewStream | null>(null);
  streamErrors = 0;
}

describe('PreviewFrame', () => {
  let fixture: ComponentFixture<Host>;

  async function show(file: FilePreview | null): Promise<void> {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.file.set(file);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;

  it('shows a video file with controls, muted and looping, and an image with its path as alt', async () => {
    await show(filePreview('people/walk.mp4', false));
    const video = root().querySelector('video')!;
    expect(video.getAttribute('src')).toBe('/media/people/walk.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);

    fixture.componentInstance.file.set(filePreview('stills/b.png', false));
    await fixture.whenStable();
    expect(root().querySelector('video')).toBeNull();
    expect(root().querySelector('img')!.getAttribute('alt')).toBe('stills/b.png');
  });

  it('shows its content beside the file, so a caller can show a live picture or a message in the same box', async () => {
    await show(null);
    expect(root().querySelector('img, video')).toBeNull();
    expect(root().querySelector('app-preview-frame .projected')?.textContent).toBe(
      'Nothing to show',
    );
  });

  it('shows a live stream as an image named by its alt, in place of the file, and reports a stream it cannot load', async () => {
    await show(filePreview('stills/b.png', false));
    fixture.componentInstance.stream.set({
      src: '/api/peripherals/cameras/preview/8f1c/stream',
      alt: 'Live preview of imx477',
    });
    await fixture.whenStable();
    const images = root().querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('/api/peripherals/cameras/preview/8f1c/stream');
    expect(images[0].alt).toBe('Live preview of imx477');

    images[0].dispatchEvent(new Event('error'));
    expect(fixture.componentInstance.streamErrors).toBe(1);

    // Its load ends when the stream goes, as an MJPEG file's does.
    fixture.componentInstance.stream.set(null);
    await fixture.whenStable();
    expect(images[0].hasAttribute('src')).toBe(false);
    expect(root().querySelector('img')!.getAttribute('alt')).toBe('stills/b.png');
  });

  it('ends an MJPEG image’s stream when the image goes, since a browser would keep it loading', async () => {
    await show(filePreview('cam.mjpeg', false));
    const image = root().querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/media-preview/mjpeg?path=cam.mjpeg');

    fixture.componentInstance.shown.set(false);
    await fixture.whenStable();
    expect(image.hasAttribute('src')).toBe(false);
  });
});
