process.argv.splice(2, 0, 'fixtures');
await import('./intent-eval.js');
