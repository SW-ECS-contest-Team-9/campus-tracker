import type { CollectorIdentity } from '../../common/auth/jwt.js';
import { TelemetryBatchRequest } from './telemetry.dto.js';
import { telemetryService } from './telemetry.service.js';

export const telemetryController = {
  batch(identity: CollectorIdentity, payload: unknown) {
    return telemetryService.ingestBatch(identity, TelemetryBatchRequest.parse(payload));
  },
};
