/**
 * @module HDDPersistenceService
 *
 * Reads and writes a `HardDrive` peripheral's backing buffer to a flat
 * disk image file. Node-only (imports `node:fs`) — must never be imported
 * by anything reachable from the browser bundle. `server/ws.ts` constructs
 * one per hard-drive peripheral and wires it in via
 * `HardDrive.setPersistenceHandler`.
 *
 * **Load-on-construct:**
 * If `imagePath` already exists and its length matches `diskStorage`, its
 * bytes are copied into `diskStorage` immediately so the drive starts up
 * with whatever was last saved. A length mismatch (e.g. a stale image from
 * a different disk geometry) is ignored, leaving `diskStorage` untouched.
 *
 * **First run:**
 * If `imagePath` doesn't exist yet, an empty file is created immediately
 * so the image is visible on disk right away instead of only appearing
 * after the first WRITE.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export class HDDPersistenceService {
  private imagePath: string;
  private diskStorage: Uint8Array; // Live reference — mutated in place on load, read from on save.

  constructor(imagePath: string, diskStorage: Uint8Array) {
    this.imagePath = imagePath;
    this.diskStorage = diskStorage;

    try {
      if (existsSync(imagePath)) {
        const savedData = readFileSync(imagePath);
        if (savedData.length === diskStorage.length) {
          this.diskStorage.set(savedData); // Seed the live buffer in place.
        }
      }
    } catch (err) {
      console.error(
        `[HDDPersistence] Failed to load "${imagePath}":`,
        (err as Error).message,
      );
    }
  }

  /**
   * Writes the entire `diskStorage` buffer to `imagePath`, overwriting it.
   * Called once per WRITE (see `HardDrive.setPersistenceHandler`), so even
   * a single changed byte re-writes the whole image rather than just
   * that byte. This could be optimized to seek and write only the
   * affected offset instead. 
   * 
   * Uses `writeFileSync`, which is synchronous
   * and blocks the event loop until the write completes.
   */
  persistData(): void {
    writeFileSync(this.imagePath, this.diskStorage);
  }
}
