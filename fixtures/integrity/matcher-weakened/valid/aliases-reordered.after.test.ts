import { describe, test, it, expect, xit } from 'vitest';
import { add, parse } from './math';

test('calls', () => {
  expect(onSave).toBeCalled();
  expect(onSave).toBeCalledWith('x');
});
