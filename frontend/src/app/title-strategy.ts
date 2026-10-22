import { inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/** The product name: the shell's app name and the prefix of every document title. */
export const APP_NAME = 'Neat Insight';

/** Titles the document `Neat Insight · <route title>`, or just the app name on untitled routes. */
@Injectable()
export class InsightTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${APP_NAME} · ${page}` : APP_NAME);
  }
}
