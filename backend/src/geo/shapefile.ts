// Minimal ESRI shapefile + dBASE reader for the terrain / building imports (no dependencies).
// Large .dbf files (the national building register is > 1 GB) are read record by record at offsets.
import fs from 'node:fs';
import { TextDecoder } from 'node:util';

export type Point2 = [number, number];
export interface ShpRecord { index: number; type: number; bbox: [number, number, number, number] | null; parts: Point2[][] }

/** Streams records; `keep(bbox)` filters before the coordinates are decoded. */
export function* readShp(path: string, keep: (bbox: [number, number, number, number]) => boolean = () => true): Generator<ShpRecord> {
  const buf = fs.readFileSync(path);
  if (buf.readInt32BE(0) !== 9994) throw new Error(`${path}: not a shapefile`);
  let offset = 100;
  while (offset + 8 <= buf.length) {
    const index = buf.readInt32BE(offset) - 1;
    const words = buf.readInt32BE(offset + 4);
    const rec = buf.subarray(offset + 8, offset + 8 + words * 2);
    offset += 8 + words * 2;
    const type = rec.readInt32LE(0);
    if (type === 0) continue;
    if (type === 1 || type === 11 || type === 21) {
      const p: Point2 = [rec.readDoubleLE(4), rec.readDoubleLE(12)];
      const bbox: [number, number, number, number] = [p[0], p[1], p[0], p[1]];
      if (keep(bbox)) yield { index, type, bbox, parts: [[p]] };
      continue;
    }
    const bbox: [number, number, number, number] = [rec.readDoubleLE(4), rec.readDoubleLE(12), rec.readDoubleLE(20), rec.readDoubleLE(28)];
    if (!keep(bbox)) continue;
    const partCount = rec.readInt32LE(36);
    const pointCount = rec.readInt32LE(40);
    const starts = Array.from({ length: partCount }, (_, i) => rec.readInt32LE(44 + i * 4));
    const base = 44 + partCount * 4;
    const pts = Array.from({ length: pointCount }, (_, i): Point2 => [rec.readDoubleLE(base + i * 16), rec.readDoubleLE(base + i * 16 + 8)]);
    yield { index, type, bbox, parts: starts.map((s, i) => pts.slice(s, starts[i + 1] ?? pointCount)) };
  }
}

/** dBASE table with random access by record index. Encoding: CP949 (EUC-KR) unless told otherwise. */
export class DbfReader {
  private readonly fd: number;
  readonly count: number;
  private readonly headerLength: number;
  private readonly recordLength: number;
  readonly fields: { name: string; length: number }[] = [];
  private readonly decoder: TextDecoder;

  constructor(path: string, encoding = 'euc-kr') {
    this.fd = fs.openSync(path, 'r');
    const head = Buffer.alloc(32);
    fs.readSync(this.fd, head, 0, 32, 0);
    this.count = head.readUInt32LE(4);
    this.headerLength = head.readUInt16LE(8);
    this.recordLength = head.readUInt16LE(10);
    this.decoder = new TextDecoder(encoding);
    const desc = Buffer.alloc(this.headerLength);
    fs.readSync(this.fd, desc, 0, this.headerLength, 0);
    for (let o = 32; desc[o] !== 0x0d; o += 32) {
      this.fields.push({ name: desc.subarray(o, o + 11).toString('latin1').replace(/\0.*$/, ''), length: desc[o + 16] });
    }
  }

  record(index: number): Record<string, string> {
    const row = Buffer.alloc(this.recordLength);
    fs.readSync(this.fd, row, 0, this.recordLength, this.headerLength + index * this.recordLength);
    const out: Record<string, string> = {};
    let o = 1;
    for (const f of this.fields) {
      out[f.name] = this.decoder.decode(row.subarray(o, o + f.length)).replace(/\0/g, '').trim();
      o += f.length;
    }
    return out;
  }

  close() {
    fs.closeSync(this.fd);
  }
}
