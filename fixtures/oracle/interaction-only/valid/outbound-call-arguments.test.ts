import { expect, test, vi } from 'vitest';
import { createAdapter } from './adapter.js';

// what the adapter hands to its logger is its output, so pinning the arguments is the check
test('logs the created product by its id', () => {
  const logSuccess = vi.fn();
  const adapter = createAdapter({ logSuccess });
  adapter.emit({ kind: 'created', id: 100 });
  expect(logSuccess).toHaveBeenCalledExactlyOnceWith('product created (id 100)');
});
