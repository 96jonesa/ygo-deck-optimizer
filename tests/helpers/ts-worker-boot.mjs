// Runs a TypeScript worker file on a real thread, for tests: Node cannot load
// `.ts` with extensionless imports itself, and `--import tsx` in a Worker's
// `execArgv` does not register the loader (ERR_UNKNOWN_FILE_EXTENSION), so
// the thread registers tsx's hooks here and then imports the real file —
// same thread, same `parentPort`.
import { workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
await import(workerData.file);
