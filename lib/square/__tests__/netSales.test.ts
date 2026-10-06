import { describe, it, expect } from 'vitest';
import { computeNetSales, monthRange, parseMonthArg, previousMonth } from '../netSales';

describe('computeNetSales', () => {
  it('nets line-item gross less discounts, excludes gift cards, counts OPEN orders', () => {
    const orders = [
      {
        state: 'COMPLETED',
        net_amounts: {
          total_money: { amount: 1100, currency: 'USD' }, // $11.00 after $2 discount + $1 tax
          tax_money: { amount: 100, currency: 'USD' },
          tip_money: { amount: 0, currency: 'USD' },
          service_charge_money: { amount: 0, currency: 'USD' },
          discount_money: { amount: 200, currency: 'USD' },
        },
        line_items: [
          { gross_sales_money: { amount: 1200 }, total_discount_money: { amount: 200 } },
        ],
      },
      {
        // A DoorDash-shaped ticket: never marked COMPLETED. Must still be counted.
        state: 'OPEN',
        net_amounts: {
          total_money: { amount: 525, currency: 'USD' },
          tax_money: { amount: 25, currency: 'USD' },
          tip_money: { amount: 50, currency: 'USD' },
          service_charge_money: { amount: 0, currency: 'USD' },
          discount_money: { amount: 0, currency: 'USD' },
        },
        line_items: [{ gross_sales_money: { amount: 450 }, total_discount_money: { amount: 0 } }],
      },
      {
        // Gift card sale: deferred revenue, excluded from net sales entirely.
        state: 'COMPLETED',
        net_amounts: {
          total_money: { amount: 2500, currency: 'USD' },
          tax_money: { amount: 0, currency: 'USD' },
          tip_money: { amount: 0, currency: 'USD' },
          service_charge_money: { amount: 0, currency: 'USD' },
          discount_money: { amount: 0, currency: 'USD' },
        },
        line_items: [
          { name: 'Gift Card', item_type: 'GIFT_CARD', gross_sales_money: { amount: 2500 }, total_discount_money: { amount: 0 } },
        ],
      },
    ];
    const s = computeNetSales(orders, 'Test 2026');
    // (1200-200) + (450-0) = 1450c = $14.50; the $25 gift card is excluded
    expect(s.netSales).toBe(14.5);
    expect(s.grossSales).toBe(16.5); // 1200 + 450
    expect(s.discounts).toBe(2.0);
    expect(s.giftCardSales).toBe(25.0);
    expect(s.tax).toBe(1.25);
    expect(s.tips).toBe(0.5);
    expect(s.orderCount).toBe(3);
    expect(s.completedOrderCount).toBe(2);
    expect(s.openOrderCount).toBe(1);
    // old formula: (1100-100) + (525-25-50) + 2500 = 3950c -> high by the gift card
    expect(s.orderLevelCheck).toBe(39.5);
    expect(s.currency).toBe('USD');
  });

  it('handles empty months', () => {
    const s = computeNetSales([], 'Empty');
    expect(s.netSales).toBe(0);
    expect(s.orderCount).toBe(0);
    expect(s.openOrderCount).toBe(0);
    expect(s.giftCardSales).toBe(0);
  });
});

describe('monthRange (America/Detroit)', () => {
  it('computes EST window + last-day date/epoch for January', () => {
    const r = monthRange(2026, 1, 'America/Detroit');
    expect(r.label).toBe('January 2026');
    expect(r.lastDayISO).toBe('2026-01-31');
    expect(r.lastDayEpochMs).toBe(Date.UTC(2026, 0, 31));
    expect(r.startAt).toBe('2026-01-01T05:00:00.000Z'); // UTC-5 in winter
    expect(r.endAt).toBe('2026-02-01T05:00:00.000Z');
  });
  it('handles February leap-length + EST', () => {
    const r = monthRange(2024, 2, 'America/Detroit');
    expect(r.lastDayISO).toBe('2024-02-29');
  });
  it('rolls the year over for December', () => {
    const r = monthRange(2026, 12, 'America/Detroit');
    expect(r.lastDayISO).toBe('2026-12-31');
    expect(r.endAt).toBe('2027-01-01T05:00:00.000Z');
  });
});

describe('month arg helpers', () => {
  it('parses YYYY-MM', () => {
    expect(parseMonthArg('2026-07')).toEqual({ year: 2026, month: 7 });
    expect(() => parseMonthArg('2026-13')).toThrow();
    expect(() => parseMonthArg('nope')).toThrow();
  });
  it('finds the previous completed month', () => {
    expect(previousMonth('America/Detroit', new Date('2026-08-04T12:00:00Z'))).toEqual({ year: 2026, month: 7 });
    expect(previousMonth('America/Detroit', new Date('2026-01-15T12:00:00Z'))).toEqual({ year: 2025, month: 12 });
  });
});
