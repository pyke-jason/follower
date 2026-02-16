ALTER TABLE `backtest_runs` ADD `live_metrics` text;--> statement-breakpoint
ALTER TABLE `run_decisions` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `run_decisions` ADD `output_tokens` integer;