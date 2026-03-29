import { createFilterParams } from './use-filter-params';

export const useBacktestListParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'createdAt', defaultDir: 'desc' },
  tag: { type: 'string' },
});
