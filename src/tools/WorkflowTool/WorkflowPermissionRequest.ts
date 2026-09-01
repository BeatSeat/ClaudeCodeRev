import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Official 2.1.153 `mZ_` (`workflowPermissionDialog`).
 * Dialog UI host is not mounted; the payload/result schemas are official.
 */
export const workflowPermissionPayloadSchema = lazySchema(() =>
  z.custom(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'requestId' in value &&
      'toolName' in value &&
      'permissionResult' in value &&
      'script' in value,
  ),
)

export const workflowPermissionResultSchema = lazySchema(() =>
  z.custom(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'behavior' in value,
  ),
)

export const workflowPermissionDialog = {
  kind: 'permission_workflow' as const,
  payload: workflowPermissionPayloadSchema,
  result: workflowPermissionResultSchema,
  default: { behavior: 'cancelled' as const },
}
