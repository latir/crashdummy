import { expect, test } from 'vitest';
import { pull } from './pull.js';

test('pulls the job that was pushed', async () => {
  const job = await pull();
  expect(job).not.toBeNull();
  expect(job!.id).toBe(1);
});
