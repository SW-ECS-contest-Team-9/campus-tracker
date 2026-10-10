// Libraries without their own type declarations, used by paved-surface.ts.
declare module 'clipper-lib' {
  const ClipperLib: any;
  export default ClipperLib;
}
declare module 'earcut' {
  /** Triangle vertex indices of a polygon given as flat coordinates; `holeIndices` = start index of each hole ring. */
  export default function earcut(data: ArrayLike<number>, holeIndices?: ArrayLike<number>, dim?: number): number[];
}
