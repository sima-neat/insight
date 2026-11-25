import { TestBed } from '@angular/core/testing';
import { SourcesSession } from './sources-session';

describe('SourcesSession', () => {
  it('remembers the form an empty slot was left on, per slot', () => {
    const session = TestBed.inject(SourcesSession);
    expect(session.emptyForm(3)).toBeUndefined();

    session.rememberEmptyForm(3, 'url');
    session.rememberEmptyForm(4, 'file');
    expect(session.emptyForm(3)).toBe('url');
    expect(session.emptyForm(4)).toBe('file');

    session.rememberEmptyForm(3, 'file');
    expect(session.emptyForm(3)).toBe('file');
  });
});
