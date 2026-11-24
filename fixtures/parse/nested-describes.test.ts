import { describe, it, expect } from 'vitest';
import { addItem, removeItem } from './cart';

describe('cart', () => {
  describe('adding', () => {
    it('adds an item', () => {
      const cart = addItem([], { id: 1, qty: 2 });
      expect(cart).toStrictEqual([{ id: 1, qty: 2 }]);
      expect(cart).toHaveLength(1);
    });

    it('adds an item', () => {
      expect(addItem([], { id: 2, qty: 1 })).toEqual([{ id: 2, qty: 1 }]);
    });
  });

  describe('removing', () => {
    it('removes an item', () => {
      expect(removeItem([{ id: 1, qty: 1 }], 1)).not.toContainEqual({ id: 1, qty: 1 });
    });
  });

  it('is empty by default', () => {
    expect(addItem([], null)).toBeDefined();
  });
});
