import { createFilterParams } from './use-filter-params';

export const useAuditParams = createFilterParams({
  status: { type: 'string', default: 'open' },
  severity: { type: 'string' },
});
