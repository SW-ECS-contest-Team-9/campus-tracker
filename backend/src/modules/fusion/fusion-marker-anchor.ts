// Collection anchors in fusion-v4 (replay only): a marker that names a network node says where the phone was at that
// moment. Its node gives a soft XY fix for the smoother and, with the barometric Z of that moment, an observation of
// the absolute height zero (node floor height + phone height - barometric Z), the same quantity as a ground contact.
import { tmInverse } from '../../geo/tm.js';
import { wgs84ToLocal } from '../../geo/wgs84-to-local.js';
import type { LocalOrigin } from '../../geo/wgs84.js';
import type { FusionConfigV4 } from './fusion.config.js';
import type { SmootherEvent } from './fusion-v4.smoother.js';

/** A marker naming a node: time (ms) and the node in EPSG:5186 with its MSL floor height. */
export interface MarkerAnchorInput { markerId: string; t: number; type: string; nodeId: string; x: number; y: number; z: number }
export interface MarkerHeightContact { t: number; offset: number; variance: number; markerId: string; nodeId: string }

const usable = (a: MarkerAnchorInput) => [a.t, a.x, a.y, a.z].every(Number.isFinite);

/** Soft XY fixes at the node positions (indices from startIndex, after the GPS fixes). */
export function markerFixEvents(anchors: MarkerAnchorInput[], origin: LocalOrigin, startIndex: number, c: FusionConfigV4): SmootherEvent[] {
  let index = startIndex;
  return anchors.filter(usable).map((a) => {
    const ll = tmInverse(a.x, a.y);
    const p = wgs84ToLocal(origin, ll.latitude, ll.longitude, 0);
    return { kind: 'fix', t: a.t, index: index++, x: p.x, y: p.y, sigma: c.markerAnchorSigmaXYM, vehicle: false };
  });
}

/** Height-zero observations: one per marker with a barometric Z at its time. */
export function markerHeightContacts(anchors: MarkerAnchorInput[], zAt: (t: number) => number | null, c: FusionConfigV4): MarkerHeightContact[] {
  return anchors.filter(usable).flatMap((a) => {
    const z = zAt(a.t);
    if (z === null || !Number.isFinite(z)) return [];
    return [{ t: a.t, offset: a.z + c.phoneHeightM - z, variance: c.markerAnchorHeightSigmaM ** 2 + c.phoneHeightSigmaM ** 2, markerId: a.markerId, nodeId: a.nodeId }];
  });
}
