import { createFilterParams } from './use-filter-params';

export const useEvalReviewParams = createFilterParams({
  sort: { type: 'sort', defaultColumn: 'timestamp', defaultDir: 'desc' },
  source: { type: 'string' },
  verified: { type: 'string' },
  confidence: { type: 'string' },
  isTrade: { type: 'string' },
});
