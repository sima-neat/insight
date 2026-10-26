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
import { readResume } from './sources/webcam-resume';
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
    // would add 22 kB) and is built on that visit, as before.
    provideAppInitializer(() => {
      if (readResume().size === 0) return;
      const injector = inject(EnvironmentInjector);
      void import('./sources/cameras.service').then(({ CamerasService }) =>
        injector.get(CamerasService),
      );
    }),
  ],
};
