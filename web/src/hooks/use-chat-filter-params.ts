import { createFilterParams } from './use-filter-params';

export const useChatFilterParams = createFilterParams({
  authors: { type: 'string' },    // comma-separated author names
  start: { type: 'string' },      // ISO date string
  end: { type: 'string' },        // ISO date string
  signals: { type: 'boolean' },   // signalsOnly flag
  label: { type: 'string' },      // 'labeled' | 'unlabeled'
  role: { type: 'string' },       // 'processed' | 'executed' | 'skipped'
});
