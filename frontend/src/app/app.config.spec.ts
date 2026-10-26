import { HttpBackend, HttpXhrBackend } from '@angular/common/http';
import { EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { appConfig, resumeWebcams } from './app.config';
import { CAMERA_MEDIA } from './sources/camera-media';
import { FakeCameraMedia } from './sources/cameras.testing';
import { readResume, writeResume } from './sources/webcam-resume';

describe('appConfig', () => {
  it('sends HTTP requests through XHR, the only backend that reports upload progress', () => {
    // The default fetch backend answers every request but never emits upload progress, so the
    // import dialog's byte progress would silently stay empty. Mocked HTTP specs cannot see it.
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(HttpBackend)).toBeInstanceOf(HttpXhrBackend);
  });

  describe('the camera service', () => {
    let media: FakeCameraMedia;

    /** Makes this page load one of the given navigation type, as the browser reports it. */
    const loadedBy = (type: NavigationTimingType | null) =>
      vi
        .spyOn(performance, 'getEntriesByType')
        .mockImplementation((kind) =>
          kind === 'navigation' && type ? [{ type } as PerformanceNavigationTiming] : [],
        );

    beforeEach(() => {
      sessionStorage.clear();
      loadedBy('reload');
      media = new FakeCameraMedia();
      TestBed.configureTestingModule({
        providers: [...appConfig.providers, { provide: CAMERA_MEDIA, useValue: media }],
      });
    });

    afterEach(() => {
      sessionStorage.clear();
      vi.restoreAllMocks();
    });

    it('is built at start when this tab has webcams to resume, on whichever page it lands', async () => {
      writeResume(1, { deviceId: 'cam-desk', sending: true });
      TestBed.inject(HttpBackend); // initializes the environment, which runs the app initializers
      await vi.waitFor(() => expect(media.listening).toBe(true));
    });

    // Session storage also comes back with "Reopen closed tab", a restored session and a return
    // through history, after the user ended the cameras by leaving: only a reload resumes them.
    it.each([
      ['a link, a typed address or a restored tab (navigate)', 'navigate'],
      ['history (back_forward)', 'back_forward'],
      ['a navigation the browser does not report', null],
    ] as const)(
      'is not built after %s, and the tab forgets its webcams',
      (_how, type) => {
        loadedBy(type);
        writeResume(1, { deviceId: 'cam-desk', sending: true });
        writeResume(2, { deviceId: 'cam-laptop', sending: false });

        expect(resumeWebcams(TestBed.inject(EnvironmentInjector))).toBeNull();
        expect(media.listening).toBe(false);
        expect(readResume().size).toBe(0);
      },
    );

    it('keeps what it resumes after a reload', async () => {
      writeResume(1, { deviceId: 'cam-desk', sending: true });
      await resumeWebcams(TestBed.inject(EnvironmentInjector));
      expect(readResume().get(1)).toEqual({ deviceId: 'cam-desk', sending: true });
    });

    it('is not built otherwise, and nothing is imported, keeping it out of the initial bundle', () => {
      expect(resumeWebcams(TestBed.inject(EnvironmentInjector))).toBeNull();
      expect(media.listening).toBe(false);
    });

    it('resolves once the service is built', async () => {
      writeResume(1, { deviceId: 'cam-desk', sending: true });
      await resumeWebcams(TestBed.inject(EnvironmentInjector));
      expect(media.listening).toBe(true);
    });
  });
});
