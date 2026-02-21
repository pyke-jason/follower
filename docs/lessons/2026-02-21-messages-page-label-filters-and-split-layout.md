Problem
The eval page was a dead-end — it only showed aggregate accuracy without useful review workflows. Reviewing labels required constantly switching between pages. No way to filter messages by label status (labeled, unlabeled, mismatched) or see related messages for context.

Decision
Deleted the eval page entirely. Moved all review workflows into the Messages page with three new features: (1) label-status filters (Labeled/Unlabeled/Mismatched toggle group), (2) a split-layout panel that shows related messages by symbol when you click any message, and (3) the compareSignals() helper in src/lib/eval.ts for fast single-pair mismatch detection without full AccuracyResult overhead.

The "mismatched" filter can't be done purely in SQL because it requires comparing JSON signal arrays between messageLabels and messageIntents. Instead, fetchMessages over-fetches labeled messages (4x page size), loads intents+labels for all of them, filters mismatches in JS, then trims to page size. This is a pragmatic tradeoff — mismatch count is small relative to labeled count.

Key Files
src/lib/eval.ts — added compareSignals() for quick label-vs-intent match check
web/app/messages/actions.ts — LabelFilter type, fetchRelatedMessages action, mismatched post-filter logic
web/app/messages/chat-room.tsx — split layout with selectedMessage + RelatedMessagesPanel
web/app/messages/related-messages-panel.tsx — new component, follows trades-table.tsx pattern
web/app/messages/chat-filters.tsx — added Labeled/Unlabeled/Mismatched toggle group
web/app/messages/chat-feed.tsx — added onMessageClick + selectedMessageId props
web/lib/queries.ts — getMessagesBySymbols (SQLite json_each), getMessages labelFilter JOIN

Watch Out
The getMessages query uses different code paths for labeled vs unlabeled filters (INNER JOIN vs LEFT JOIN). The "mismatched" filter piggybacks on the "labeled" SQL filter then post-filters in the action — if there are very few mismatches relative to labeled messages, pagination may return fewer than PAGE_SIZE results. The ChatFeed expects messages in DESC order (newest first) and reverses internally for chronological display.
