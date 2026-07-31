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
 * If `imagePath` doesn't exist yet, loading is skipped and `diskStorage`
 * stays as constructed (zeroed). The file is created lazily on the first
 * `persistData` call, whether that's a single-byte write or a full-buffer
 * write (see `persistData`).
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";

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
   * Persists `diskStorage` to `imagePath`, synchronously.
   *
   * With `changedIndex` (the normal case — see `HardDrive.setPersistenceHandler`,
   * called once per WRITE), only that single byte is seeked to and rewritten
   * in place, leaving the rest of the file untouched. Without it, the entire
   * buffer overwrites the file — used for bulk operations like `formatDisk()`
   * where there's no single changed offset.
   *
   * Failures (missing file, permission errors, etc.) are caught, logged,
   * and swallowed — a disk-write error here must not throw back through
   * `HardDrive.tick()` and crash the CPU loop.
   */
  persistData(changedIndex?: number): void {
    if (changedIndex == undefined) {
      try {
        writeFileSync(this.imagePath, this.diskStorage);
        return;
      } catch (err) {
        console.error(
          `[HDDPersistence] Failed to write full disk image to "${this.imagePath}":`,
          (err as Error).message,
        );
        return;
      }
    }

    let fd: number | undefined;
    try {
      // "r+" requires the file to already exist; "w+" creates it.
      fd = openSync(this.imagePath, existsSync(this.imagePath) ? "r+" : "w+");
      writeSync(
        fd,
        this.diskStorage,
        changedIndex, // offset
        1, // len (1 byte)
        changedIndex, // position
      );
    } catch (err) {
      console.error(
        `[HDDPersistence] Failed to persist byte ${changedIndex} to "${this.imagePath}":`,
        (err as Error).message,
      );
    } finally {
      if (fd != undefined) closeSync(fd);
    }
  }
}

