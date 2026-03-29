import { createFilterParams } from './use-filter-params';

export const useTaskListParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'createdAt', defaultDir: 'desc' },
  status: { type: 'string' },
});
