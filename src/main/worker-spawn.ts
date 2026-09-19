import createWorker from '../worker/optimizer.worker?nodeWorker';
import type { WorkerLike } from './services/runs';

// The one file that knows the optimizer worker is a real `worker_threads`
// thread (TDD §3); everything else sees a `WorkerLike`. Imported by
// `index.ts` only: `?nodeWorker` is electron-vite's, and means nothing to
// vitest — what runs on the thread is tested through `worker/session.ts` and,
// on a real thread, in tests/worker/optimizer.worker.test.ts.
//
// WHERE THE THREAD'S FILE IS (proven in M2b, TDD §19). electron-vite emits
// the worker as a chunk of main's build — `out/main/optimizer.worker-<hash>.js`,
// beside `out/main/index.js`, with the `core/` code the two share in one more
// chunk beside them (`out/main/<name>-<hash>.js`, which imports nothing: no
// Electron, no sql.js reaches the thread) — and turns this import into
// `new Worker(new URL('./optimizer.worker-<hash>.js', import.meta.url))`. The
// path is relative to main's own bundle, so it holds in `npm run dev`, in the
// built app, and INSIDE `app.asar`: Electron's asar-aware `fs` serves
// `worker_threads` too (verified by running the built app from a hand-packed
// `app.asar` — the thread loads from `…/app.asar/out/main/…`, imports its
// shared chunk from there, and the cancel flag's shared memory works).
//
// PACKAGING (M4): no `asarUnpack` entry is needed — TDD §17's "no asarUnpack"
// stands. Should an Electron upgrade ever break asar reads from a worker
// thread (the symptom: `ERR_MODULE_NOT_FOUND …/app.asar/out/main/optimizer.worker-*.js`
// in packaged builds only), the entry is `asarUnpack: ["out/main/**"]` — the
// worker AND the chunks it imports — and this file then needs the thread's URL
// rewritten from `app.asar` to `app.asar.unpacked`, which `?nodeWorker` does
// not do (only `?asset&asarUnpack` does): take `?modulePath` instead and
// construct the `Worker` here.

export function spawnOptimizerWorker(): WorkerLike {
  return createWorker({});
}
