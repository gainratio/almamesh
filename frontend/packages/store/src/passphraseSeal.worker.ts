/**
 * Runs one backup seal or open off the UI thread. scrypt is synchronous and
 * holds 128 MiB, so it must never run on the page's thread. The caller
 * (`backupSealing.ts`) spawns one worker per operation and terminates it, so
 * the memory is returned as soon as the file is sealed or opened.
 */
import { handleSealRequest, type SealReply, type SealRequest } from './passphraseSeal';

/** The slice of DedicatedWorkerGlobalScope this worker uses (the package compiles with DOM libs). */
interface SealWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<SealRequest>) => void): void;
  postMessage(message: SealReply, transfer: Transferable[]): void;
}

const scope = self as unknown as SealWorkerScope;

scope.addEventListener('message', (event: MessageEvent<SealRequest>) => {
  void handleSealRequest(event.data).then((reply) => {
    scope.postMessage(reply, reply.ok ? [reply.bytes.buffer] : []);
  });
});
