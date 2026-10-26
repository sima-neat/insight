import { HttpBackend, HttpXhrBackend } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';
import { CAMERA_MEDIA } from './sources/camera-media';
import { FakeCameraMedia } from './sources/cameras.testing';
import { writeResume } from './sources/webcam-resume';

describe('appConfig', () => {
  it('sends HTTP requests through XHR, the only backend that reports upload progress', () => {
    // The default fetch backend answers every request but never emits upload progress, so the
    // import dialog's byte progress would silently stay empty. Mocked HTTP specs cannot see it.
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(HttpBackend)).toBeInstanceOf(HttpXhrBackend);
  });

  describe('the camera service', () => {
    let media: FakeCameraMedia;

    beforeEach(() => {
      sessionStorage.clear();
      media = new FakeCameraMedia();
      TestBed.configureTestingModule({
        providers: [...appConfig.providers, { provide: CAMERA_MEDIA, useValue: media }],
      });
    });

    afterEach(() => sessionStorage.clear());

    it('is built at start when this tab has webcams to resume, on whichever page it lands', async () => {
      writeResume(1, { deviceId: 'cam-desk', sending: true });
      TestBed.inject(HttpBackend); // initializes the environment, which runs the app initializers
      await vi.waitFor(() => expect(media.listening).toBe(true));
    });

    it('waits for its first visit to Streaming otherwise, keeping it out of the initial bundle', async () => {
      TestBed.inject(HttpBackend);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(media.listening).toBe(false);
    });
  });
});
