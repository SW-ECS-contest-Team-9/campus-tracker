// RSSI model selection and the log-distance path loss model (pure: no DB). Shared by the config API and fusion.

export interface CalibrationRow {
  beaconId: string | null;
  platform: '*' | 'ios' | 'android';
  deviceGroup: string;
  measuredPower1m: number;
  pathLossExponent: number;
  rssiVariance: number;
  sampleCount: number;
}

export interface RssiModel {
  measuredPower1m: number;
  pathLossExponent: number;
  /** dB^2 */
  rssiVariance: number;
  /** where the model came from, most specific first: BEACON_DEVICE .. DEFAULT */
  source: 'BEACON_DEVICE' | 'BEACON_PLATFORM' | 'BEACON' | 'GLOBAL_DEVICE' | 'GLOBAL_PLATFORM' | 'GLOBAL' | 'ADVERTISED' | 'DEFAULT';
}

export interface RssiDefaults { measuredPower1m: number; pathLossExponent: number; rssiVariance: number }

/**
 * Used until a beacon is calibrated: a typical iBeacon 1 m power, an indoor exponent and a wide 6 dB sigma
 * (body shadowing and multipath easily move RSSI by 5-10 dB), so an uncalibrated beacon is a weak constraint.
 */
export const BEACON_RSSI_DEFAULTS: RssiDefaults = { measuredPower1m: -59, pathLossExponent: 2.2, rssiVariance: 36 };

/**
 * Most specific calibration for (beacon, platform, device model): this beacon before the global defaults, then
 * the exact device group before the platform before '*'. Without any row: the beacon's advertised 1 m power with
 * the default exponent and variance, else the defaults. Platforms differ (iOS reports a ~1 s Core Location
 * aggregate, Android single advertisements), so a calibration measured on one platform is not used on the other.
 */
export function selectRssiModel(rows: CalibrationRow[], beaconId: string | null, platform: string, deviceModel: string | null | undefined,
  advertisedPower: number | null | undefined, defaults: RssiDefaults): RssiModel {
  const order: [string | null, string, string, RssiModel['source']][] = [
    [beaconId, platform, deviceModel ?? '', 'BEACON_DEVICE'],
    [beaconId, platform, '*', 'BEACON_PLATFORM'],
    [beaconId, '*', '*', 'BEACON'],
    [null, platform, deviceModel ?? '', 'GLOBAL_DEVICE'],
    [null, platform, '*', 'GLOBAL_PLATFORM'],
    [null, '*', '*', 'GLOBAL'],
  ];
  for (const [b, p, g, source] of order) {
    if (b === null && source.startsWith('BEACON')) continue;
    if (!g) continue;
    const row = rows.find((r) => r.beaconId === b && r.platform === p && r.deviceGroup === g);
    if (row) return { measuredPower1m: row.measuredPower1m, pathLossExponent: row.pathLossExponent, rssiVariance: row.rssiVariance, source };
  }
  if (advertisedPower !== null && advertisedPower !== undefined && Number.isFinite(advertisedPower) && advertisedPower < 0) {
    return { ...defaults, measuredPower1m: advertisedPower, source: 'ADVERTISED' };
  }
  return { ...defaults, source: 'DEFAULT' };
}

/** Distance (m) at which the model expects this RSSI: d = 10^((P1m - rssi) / (10 n)). */
export function modelRange(rssi: number, m: Pick<RssiModel, 'measuredPower1m' | 'pathLossExponent'>): number {
  return 10 ** ((m.measuredPower1m - rssi) / (10 * m.pathLossExponent));
}

/** 1-sigma of ln(range) implied by the RSSI noise: sigma_ln = sigma_dB * ln(10) / (10 n). */
export function lnRangeSigma(rssiVariance: number, pathLossExponent: number): number {
  return (Math.sqrt(rssiVariance) * Math.LN10) / (10 * pathLossExponent);
}
