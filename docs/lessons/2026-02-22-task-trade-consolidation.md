Task/Trade Detail Page Consolidation

Problem: The task detail page (/tasks/[id]) and trade detail page (/trades/[id]) showed overlapping information about the same event. Understanding a trade required bouncing between both pages. Additionally, the task page had a 70-line inline copy of the Parsed Context rendering logic.

Decision: Minimal merge. Added collapsible DecisionReasoning and ParsedContext accordion sections to the trade detail page. Tasks that produced a trade (EXECUTE decisions) redirect from /tasks/[id] to /trades/[id]?from=tasks. SKIP, PENDING, IN_PROGRESS, and FAILED tasks stay on the task page unchanged. The redirect fires before expensive parallel queries, so no wasted DB work.

Key Files:
  web/app/trades/[id]/decision-reasoning.tsx -- new collapsible component, shows badge/path/pnl/duration/reasoning
  web/app/trades/[id]/parsed-context.tsx -- new reusable component, shows confidence/action/direction/strategies/badges
  web/app/trades/[id]/page.tsx -- fetches task+runDecision, renders new sections, ?from=tasks back-nav
  web/app/tasks/[id]/page.tsx -- redirect logic + imports ParsedContext component instead of inline duplication
  web/app/trades/actions.ts -- TradeStory extended with taskContext/taskResult
  web/app/components/outcome-legs-summary.tsx -- removed redundant "View Decision" link

Watch Out:
  The fill-quality.tsx component had a pre-existing bug: it cast brokerLegFills to made-up field names (fillPrice, fillQty, side) that don't match the actual LegFill type (filledPrice, filledQuantity, commission). Fixed during cleanup. Always trust $type<>() annotations on Drizzle JSON columns instead of adding as casts.
  When deduplicating inline rendering into a shared component, remember to also remove the imports that were only needed by the inlined code (Badge, InfoChip, StatItem, cn were still used elsewhere in the task page, but TaskContext/TaskResult type imports became unnecessary).
