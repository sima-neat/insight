import { provideHttpClient, withXhr } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideNeatTitles, provideNeatUi } from '@sima/neat-ui';
import { APP_NAME } from './app-name';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // The tab reads `Neat Insight · <route title>`, or the app name alone on untitled routes.
    provideNeatTitles(APP_NAME),
    // XHR, not the default fetch backend: only XHR reports upload progress, which the import
    // dialog's byte progress needs.
    provideHttpClient(withXhr()),
    provideNeatUi(),
  ],
};
