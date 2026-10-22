import { createReadStream } from "node:fs";
import { crc32, createDeflateRaw } from "node:zlib";
import { pipeline } from "node:stream";
import { AppError } from "@palimvo/core";

/** One member of the archive. Folders end in "/" and have no source. */
export interface ZipEntry {
  /** Path inside the archive, with "/" separators. */
  name: string;
  /** Absolute path of the file to store; leave out for a folder. */
  source?: string;
  /** Modification time in milliseconds. */
  mtime: number;
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const SIGNATURE = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, data: 0x08074b50 };
/** Bit 3: sizes follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0008 | 0x0800;

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 1)));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function tooBig(): never {
  throw new AppError("payload_too_large", undefined, {
    reason: "ZIP downloads are limited to 4 GiB and 65535 entries.",
  });
}

/**
 * Streams a ZIP archive: each file is read and deflated in chunks, so memory use stays flat
 * however large the folder is. Sizes and checksums are written after the data (a data
 * descriptor). The classic format is used (no ZIP64), so an archive may hold at most 65535
 * entries and 4 GiB; beyond that the stream fails with `payload_too_large`.
 */
export async function* zipStream(entries: readonly ZipEntry[]): AsyncGenerator<Buffer> {
  if (entries.length > U16_MAX) tooBig();
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const { time, date } = dosDateTime(entry.mtime);
    const isFile = entry.source !== undefined;
    const method = isFile ? 8 : 0;
    const flags = isFile ? FLAGS : 0x0800;
    const start = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIGNATURE.local, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    let packed = 0;
    if (isFile) {
      const source = createReadStream(entry.source!);
      const deflate = createDeflateRaw();
      source.on("data", (chunk) => {
        const bytes = chunk as Buffer;
        crc = crc32(bytes, crc);
        size += bytes.length;
      });
      // `pipeline` forwards a read error to the deflate stream, which then rejects the loop below.
      pipeline(source, deflate, () => undefined);
      for await (const chunk of deflate) {
        const bytes = chunk as Buffer;
        packed += bytes.length;
        offset += bytes.length;
        if (offset > U32_MAX) tooBig();
        yield bytes;
      }
      if (size > U32_MAX) tooBig();
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(SIGNATURE.data, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed, 8);
      descriptor.writeUInt32LE(size, 12);
      yield descriptor;
      offset += descriptor.length;
    }

    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIGNATURE.central, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    if (!isFile) header.writeUInt32LE(0x10, 38); // MS-DOS directory attribute
    header.writeUInt32LE(start, 42);
    central.push(header, name);
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  if (offset + centralSize > U32_MAX) tooBig();
  for (const part of central) yield part;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIGNATURE.end, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
