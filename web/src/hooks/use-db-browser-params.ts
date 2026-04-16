import { createFilterParams } from './use-filter-params';

const useDbBrowserParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'id', defaultDir: 'desc' },
  table: { type: 'string', default: '' },
  filters: { type: 'string', default: '' }, // JSON-encoded Filter[]
});

export { useDbBrowserParams };
