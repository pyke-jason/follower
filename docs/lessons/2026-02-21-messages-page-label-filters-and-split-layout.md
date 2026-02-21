Problem
The eval page was a dead-end — it only showed aggregate accuracy without useful review workflows. Reviewing labels required constantly switching between pages. No way to filter messages by label status (labeled, unlabeled, mismatched) or see related messages for context.

Decision
Deleted the eval page entirely and its dead code (computeGlobalAccuracy, getLabels). Moved all review workflows into the Messages page with four filter modes: (1) Labeled — reviewed ground-truth labels exist, (2) Unlabeled — no reviewed label, (3) Mismatched — label disagrees with AI intent, (4) Needs Review — AI flagged with MANUAL_REVIEW decision. Also added a split-layout panel that shows related messages by symbol when you click any message, and the compareSignals() helper in src/lib/eval.ts for fast single-pair mismatch detection.

The "mismatched" filter can't be done purely in SQL because it requires comparing JSON signal arrays between messageLabels and messageIntents. Instead, fetchMessages over-fetches labeled messages (4x page size), loads intents+labels for all of them, filters mismatches in JS, then trims to page size. This is a pragmatic tradeoff — mismatch count is small relative to labeled count.

Key Files
src/lib/eval.ts — added compareSignals() for quick label-vs-intent match check
web/app/messages/actions.ts — LabelFilter type, fetchRelatedMessages action, mismatched post-filter logic
web/app/messages/chat-room.tsx — split layout with selectedMessage + RelatedMessagesPanel
web/app/messages/related-messages-panel.tsx — new component, follows trades-table.tsx pattern
web/app/messages/chat-filters.tsx — added Labeled/Unlabeled/Mismatched/Needs Review toggle group
web/app/messages/chat-feed.tsx — added onMessageClick + selectedMessageId props
web/lib/queries.ts — getMessagesBySymbols (SQLite json_each), getMessages labelFilter JOINs, removed dead computeGlobalAccuracy/getLabels

Watch Out
The getMessages query uses different code paths per filter: labeled (INNER JOIN messageLabels), unlabeled (LEFT JOIN + IS NULL), needs-review (INNER JOIN messageIntents where decision = MANUAL_REVIEW). The "mismatched" filter piggybacks on the "labeled" SQL filter then post-filters in the action — if there are very few mismatches relative to labeled messages, pagination may return fewer than PAGE_SIZE results. The needs-review JOIN on messageIntents may return duplicate messages if multiple intent versions exist — acceptable since the deduplication happens client-side via message ID keying. The ChatFeed expects messages in DESC order (newest first) and reverses internally for chronological display.
