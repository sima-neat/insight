import { provideHttpClient, withXhr } from '@angular/common/http';
import {
  ApplicationConfig,
  EnvironmentInjector,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, TitleStrategy, withComponentInputBinding } from '@angular/router';
import { provideNeatUi } from '@sima/neat-ui';
import { routes } from './app.routes';
import { forgetResume, loadedByReload, readResume } from './sources/webcam-resume';
import { InsightTitleStrategy } from './title-strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: TitleStrategy, useClass: InsightTitleStrategy },
    // XHR, not the default fetch backend: only XHR reports upload progress, which the import
    // dialog's byte progress needs (`postStreamedText`), and it gives the same streamed text.
    provideHttpClient(withXhr()),
    provideNeatUi(),
    // A reload leaves this tab's webcams to resume, on whichever page it lands, and the camera
    // service does that when it is built. So with something to resume, build it at start rather
    // than on the first visit to Streaming. Without, it stays out of the initial bundle (it
    // would add 22 kB) and is built on that visit, as before. Any other load forgets them.
    provideAppInitializer(() => {
      void resumeWebcams(inject(EnvironmentInjector));
    }),
  ],
};

/**
 * Builds the camera service, which resumes the tab's webcams as it starts, when there are any to
 * resume; resolves once it is built. Returns null, importing nothing, when there are none. Only a
 * reload resumes: after any other load (a restored tab, a return through history) the entries
 * are forgotten here, before anything reads them, and the service is built on its first use.
 */
export function resumeWebcams(injector: EnvironmentInjector): Promise<void> | null {
  if (readResume().size === 0) return null;
  if (!loadedByReload()) {
    forgetResume();
    return null;
  }
  return import('./sources/cameras.service')
    .then(({ CamerasService }) => {
      injector.get(CamerasService);
    })
    .catch(() => {
      // Resuming is best effort: the chunk can fail to load (a redeploy replaced it), and the
      // page must start all the same. The service is then built on the first visit to Streaming.
    });
}
