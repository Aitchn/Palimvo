/**
 * The sandbox worker's code as one string. The production bundle (`scripts/bundle.mjs`) replaces
 * this file with the worker built on its own, so `dist/palimvo.mjs` stays a single file. From
 * source it is undefined and the pool starts `worker.ts` directly.
 */
export const workerSource: string | undefined = undefined;
