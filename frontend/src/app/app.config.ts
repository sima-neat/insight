import { provideHttpClient, withXhr } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, TitleStrategy, withComponentInputBinding } from '@angular/router';
import { provideNeatUi } from '@sima/neat-ui';
import { routes } from './app.routes';
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
  ],
};
