import { Routes } from '@angular/router';

/**
 * One lazily loaded route per page, titled with the page's rail label. The old React app's paths
 * keep working: its aliases `/rtsp` and `/visualizer` redirect to their pages, and `/` and every
 * unknown path (old `/workspace` and `/genai` bookmarks included) land on Streaming.
 */
export const routes: Routes = [
  {
    path: 'media',
    title: 'Media',
    loadComponent: () => import('./pages/media/media.page').then((m) => m.MediaPage),
  },
  {
    path: 'streaming',
    title: 'Streaming',
    loadComponent: () => import('./pages/streaming/streaming.page').then((m) => m.StreamingPage),
  },
  {
    path: 'viewer',
    title: 'Viewer',
    loadComponent: () => import('./pages/viewer/viewer.page').then((m) => m.ViewerPage),
  },
  {
    path: 'peripherals',
    title: 'Peripherals',
    loadComponent: () =>
      import('./pages/peripherals/peripherals.page').then((m) => m.PeripheralsPage),
  },
  {
    path: 'stats',
    title: 'Stats',
    loadComponent: () => import('./pages/stats/stats.page').then((m) => m.StatsPage),
  },
  { path: 'rtsp', redirectTo: 'streaming' },
  { path: 'visualizer', redirectTo: 'stats' },
  { path: '', pathMatch: 'full', redirectTo: 'streaming' },
  { path: '**', redirectTo: 'streaming' },
];
