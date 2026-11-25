import { HttpBackend, HttpXhrBackend } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';

describe('appConfig', () => {
  it('sends HTTP requests through XHR, the only backend that reports upload progress', () => {
    // The default fetch backend answers every request but never emits upload progress, so the
    // import dialog's byte progress would silently stay empty. Mocked HTTP specs cannot see it.
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(HttpBackend)).toBeInstanceOf(HttpXhrBackend);
  });
});
