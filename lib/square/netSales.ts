// lib/square/netSales.ts — pull Square orders for a month and compute "Net Sales".
//
// Square has NO direct "net sales" report endpoint, so we aggregate the Orders API
// (POST /v2/orders/search).
//
//     Net Sales = Σ over line items of (gross_sales_money − total_discount_money),
//                 gift cards excluded
//
// This is deliberately the SAME definition the monthly Food/Drink/Other cafe income
// allocation uses, so the scorecard and the accountant's figures agree. Two parts of it
// are easy to get wrong and both were, before 2026-10-06:
//
//   1. ORDER STATES. We count COMPLETED *and* OPEN. DoorDash tickets sit in OPEN and are
//      never marked COMPLETED, so a COMPLETED-only query silently drops them — $835 of
//      September 2026, and DoorDash has roughly tripled across the year. Note that OPEN
//      orders have no `closed_at`, so the date filter must be `created_at`; adding OPEN
//      to the state filter while bucketing on closed_at is a no-op.
//
//   2. GIFT CARDS. A gift card sale is deferred revenue, not revenue — it is recognised
//      again when the card is redeemed, so counting the sale double counts. The previous
//      order-level formula (net_amounts.total − tax − tip − service charge) included
//      them. They are reported separately as `giftCardSales`.
//
// `orderLevelCheck` keeps the old order-level formula as a drift signal. It is expected
// to sit ABOVE netSales by roughly the gift card total, and to differ slightly again
// because net_amounts is already net of returns while the line items are not.
//
// Money is integer cents; we keep cents internally and expose dollars on the summary.

import { SquareClient, square } from './client';

// ---- Money helpers -------------------------------------------------------
interface Money { amount?: number; currency?: string }
const cents = (m?: Money): number => (m && typeof m.amount === 'number' ? m.amount : 0);

// ---- Time / month helpers (timezone-aware, dependency-free) --------------
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Offset (ms) of `date` in `timeZone`, i.e. localWallClock - UTC. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** The UTC instant of a wall-clock time in `timeZone`. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

export interface MonthRange {
  year: number;
  month: number;        // 1-12
  label: string;        // "January 2026"
  startAt: string;      // RFC3339 UTC, inclusive
  endAt: string;        // RFC3339 UTC, exclusive (next month start)
  lastDayISO: string;   // "2026-01-31"
  lastDayEpochMs: number; // midnight UTC of the last day (GHL date-field convention)
}

export function monthRange(year: number, month: number, tz: string): MonthRange {
  const start = zonedToUtc(year, month, 1, 0, 0, 0, tz);
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const end = zonedToUtc(ny, nm, 1, 0, 0, 0, tz);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year, month,
    label: `${MONTHS[month - 1]} ${year}`,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    lastDayISO: `${year}-${pad(month)}-${pad(lastDay)}`,
    lastDayEpochMs: Date.UTC(year, month - 1, lastDay),
  };
}

/** Parse "YYYY-MM" → {year, month}. */
export function parseMonthArg(s: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Bad --month "${s}". Use YYYY-MM, e.g. 2026-07.`);
  const year = +m[1], month = +m[2];
  if (month < 1 || month > 12) throw new Error(`Bad month in "${s}".`);
  return { year, month };
}

/** The most recent fully-completed month, in the given timezone. */
export function previousMonth(tz: string, now: Date = new Date()): { year: number; month: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(now)) p[part.type] = part.value;
  let year = +p.year, month = +p.month - 1;
  if (month < 1) { month = 12; year -= 1; }
  return { year, month };
}

// ---- Order fetch + aggregation -------------------------------------------
export type TimestampField = 'closed_at' | 'created_at';

export async function searchOrders(
  client: SquareClient,
  locationId: string,
  range: MonthRange,
  timestampField: TimestampField = 'created_at',
): Promise<any[]> {
  const orders: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = {
      location_ids: [locationId],
      limit: 500,
      query: {
        filter: {
          state_filter: { states: ['COMPLETED', 'OPEN'] },
          date_time_filter: { [timestampField]: { start_at: range.startAt, end_at: range.endAt } },
        },
        sort: { sort_field: timestampField.toUpperCase(), sort_order: 'ASC' },
      },
    };
    if (cursor) body.cursor = cursor;
    const res = await client.request<any>({ method: 'POST', path: '/v2/orders/search', body });
    for (const o of res.orders ?? []) orders.push(o);
    cursor = res.cursor;
  } while (cursor);
  return orders;
}

export interface NetSalesSummary {
  label: string;
  currency: string;
  orderCount: number;
  completedOrderCount: number;
  openOrderCount: number;
  // dollars, rounded to cents
  netSales: number;        // Σ line (gross − discount), gift cards excluded
  grossSales: number;      // Σ line gross, gift cards excluded
  discounts: number;       // Σ line discount, gift cards excluded
  giftCardSales: number;   // deferred revenue, deliberately NOT in netSales
  tax: number;
  tips: number;
  serviceCharges: number;
  totalCollected: number;
  // old order-level formula, kept as a drift signal — see the header note
  orderLevelCheck: number;
}

/** Gift card lines are deferred revenue and never count toward net sales. */
const GIFT_CARD_NAMES = new Set(['Gift Card', 'eGift Card', 'GiftCardGifted']);
function isGiftCardLine(li: any): boolean {
  return li?.item_type === 'GIFT_CARD' || GIFT_CARD_NAMES.has(li?.name);
}

/** Compute the Net Sales summary from a list of COMPLETED and OPEN orders. */
export function computeNetSales(orders: any[], label: string): NetSalesSummary {
  let grossC = 0, discC = 0, giftC = 0;
  let taxC = 0, tipC = 0, svcC = 0, totalC = 0, orderLevelC = 0;
  let completed = 0, open = 0;
  let currency = 'USD';
  for (const o of orders) {
    if (o.state === 'OPEN') open += 1; else if (o.state === 'COMPLETED') completed += 1;
    const na = o.net_amounts ?? {};
    if (na.total_money?.currency) currency = na.total_money.currency;
    taxC += cents(na.tax_money);
    tipC += cents(na.tip_money);
    svcC += cents(na.service_charge_money);
    totalC += cents(na.total_money);
    // Drift signal only: the order-level formula this module used before 2026-10-06.
    orderLevelC += cents(na.total_money) - cents(na.tax_money)
      - cents(na.tip_money) - cents(na.service_charge_money);

    for (const li of o.line_items ?? []) {
      const g = cents(li.gross_sales_money);
      const dsc = cents(li.total_discount_money);
      if (isGiftCardLine(li)) { giftC += g - dsc; continue; }
      grossC += g;
      discC += dsc;
    }
  }
  const netC = grossC - discC;
  const d = (c: number) => Math.round(c) / 100;
  return {
    label, currency,
    orderCount: orders.length, completedOrderCount: completed, openOrderCount: open,
    netSales: d(netC), grossSales: d(grossC), discounts: d(discC), giftCardSales: d(giftC),
    tax: d(taxC), tips: d(tipC), serviceCharges: d(svcC), totalCollected: d(totalC),
    orderLevelCheck: d(orderLevelC),
  };
}

/** One-call convenience: fetch a month's orders and compute the summary. */
export async function getMonthlyNetSales(
  year: number,
  month: number,
  opts: { client?: SquareClient; timezone?: string; timestampField?: TimestampField } = {},
): Promise<{ range: MonthRange; summary: NetSalesSummary; orders: any[] }> {
  const client = opts.client ?? square();
  const tz = opts.timezone ?? client.config.timezone;
  const range = monthRange(year, month, tz);
  const orders = await searchOrders(client, client.locationId, range, opts.timestampField ?? 'created_at');
  const summary = computeNetSales(orders, range.label);
  return { range, summary, orders };
}
