/**
 * Save Events - in-process pub/sub for save completion notifications.
 *
 * Allows export routes to await confirmation that a forcesave callback
 * has completed (file persisted to S3) without polling.
 *
 * Usage:
 *   - callback.ts calls notifySaveComplete(fileId) after S3 upload
 *   - export routes call waitForSave(fileId) after issuing forcesave
 */

import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

/**
 * Notify that a file has been successfully saved to S3.
 * Called by the DS callback handler after upload completes.
 */
export function notifySaveComplete(fileId: string): void {
  console.log(`[save-events] Emitting save complete for file=${fileId}`);
  emitter.emit(`saved:${fileId}`);
}

/**
 * Wait for a file save to complete.
 * Resolves true when the save event fires, false on timeout.
 */
export function waitForSave(fileId: string, timeoutMs: number = 10000): Promise<boolean> {
  return new Promise(resolve => {
    const event = `saved:${fileId}`;

    const timer = setTimeout(() => {
      emitter.removeAllListeners(event);
      resolve(false);
    }, timeoutMs);

    emitter.once(event, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
