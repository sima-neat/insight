import { inject, Injectable } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { APP_NAME } from './app-name';

/** Titles the document `Neat Insight · <route title>`, or just the app name on untitled routes. */
@Injectable()
export class InsightTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${APP_NAME} · ${page}` : APP_NAME);
  }
}
