import { FullConfig } from '@playwright/test';
import { rm } from 'node:fs/promises';

/**
 * Deletes the test output directories once a run against a deployed build is over. A failed
 * web-first assertion attaches a snapshot of the page it saw to `error-context.md`, and the
 * owner's rule is that their running Insight UI is never captured without explicit permission.
 * The failure messages in the terminal stay; they carry only what the assertion compared.
 */
export default async function discardArtifacts(config: FullConfig): Promise<void> {
  await Promise.all(
    config.projects.map((project) => rm(project.outputDir, { recursive: true, force: true })),
  );
}
