
import { describe, test, expect } from '@jest/globals';
import dayjs from 'dayjs';
import { Timestamp } from 'firebase/firestore';
import { calculateFifoHistory } from '../utils/inventoryFifo';
import type { Shipment, SalesReport } from '../types';

// 実在庫手動補正 (manual_stock_*) を FIFO 履歴に「補正日のロス事象」として計上し、
// 以降の在庫を補正値から繰り越す挙動のテスト。
// calculateFifoHistory は内部で dayjs() (today) に依存するため、すべて今日からの相対日付で組み、
// historyStartDate を渡して計算開始日を固定する（決定的に）。

const NO_EXPIRE = 999; // 賞味期限の影響を排除して補正ロジックだけを検証する

const ymd = (daysAgo: number): string =>
    dayjs().subtract(daysAgo, 'day').format('YYYY-MM-DD');

// JST正午で固定（日付境界のブレを避ける）
const tsDaysAgo = (daysAgo: number): Timestamp =>
    Timestamp.fromDate(dayjs().subtract(daysAgo, 'day').hour(12).minute(0).second(0).millisecond(0).toDate());

const makeMixShipment = (daysAgo: number, mix: number): Shipment => ({
    registrationType: 'serif',
    shipDate: tsDaysAgo(daysAgo),
    createdAt: tsDaysAgo(daysAgo),
    status: 'completed',
    details: { clientId: 'TEST', quantity: { pack6: 0, pack10: 0, mix, tray: 0, simple: 0 } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テストmockの柔軟性確保のため
}) as any;

const makeMixSale = (daysAgo: number, mix: number): SalesReport => ({
    shopId: 'TEST',
    date: tsDaysAgo(daysAgo),
    breakdown_mix: mix,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- テストmockの柔軟性確保のため
}) as any;

const lastClosing = (history: { closingStock: number }[]): number =>
    history.length > 0 ? history[history.length - 1].closingStock : 0;

describe('calculateFifoHistory — 実在庫手動補正 (manualAdjustment)', () => {
    test('補正日にロスを計上し、補正値が最新在庫まで繰り越される', () => {
        // 5日前に MIX 30P 納品、売上なし
        const shipments = [makeMixShipment(5, 30)];
        const sales: SalesReport[] = [];

        // 補正なし: 最新在庫は計算通り 30P
        const raw = calculateFifoHistory(shipments, sales, 'mix', NO_EXPIRE, 0, false, ymd(10));
        expect(lastClosing(raw)).toBe(30);

        // 補正あり: 2日前に実在庫 7P へ補正 → 差分 23P をロス計上
        const adjusted = calculateFifoHistory(shipments, sales, 'mix', NO_EXPIRE, 0, false, ymd(10), {
            date: ymd(2),
            targetStock: 7,
        });

        // 補正日の行: 在庫が 7P に確定し、補正(ロス) -23 が記録される
        const correctionRow = adjusted.find((r) => r.date === ymd(2));
        expect(correctionRow).toBeDefined();
        expect(correctionRow!.closingStock).toBe(7);
        expect(correctionRow!.adjusted).toBe(-23);

        // 補正日以降、在庫は 7P を起点に繰り越される（最新在庫 = 7P）
        expect(lastClosing(adjusted)).toBe(7);
    });

    test('補正後の売上はゴースト在庫を二重計上せず、補正値から消し込む', () => {
        // 5日前に 30P 納品 → 2日前に実在庫 7P へ補正 → 1日前に 3P 売上
        const shipments = [makeMixShipment(5, 30)];
        const sales = [makeMixSale(1, 3)];

        const adjusted = calculateFifoHistory(shipments, sales, 'mix', NO_EXPIRE, 0, false, ymd(10), {
            date: ymd(2),
            targetStock: 7,
        });

        // 補正値 7P から 3P 売れて 4P。 30-3=27 ではない（ゴースト23Pは復活しない）
        expect(lastClosing(adjusted)).toBe(4);
    });

    test('実在庫が計算値より多い場合は増加補正として在庫を積み増す', () => {
        // 5日前に 5P 納品 → 2日前に実在庫 12P へ補正（+7P）
        const shipments = [makeMixShipment(5, 5)];
        const sales: SalesReport[] = [];

        const adjusted = calculateFifoHistory(shipments, sales, 'mix', NO_EXPIRE, 0, false, ymd(10), {
            date: ymd(2),
            targetStock: 12,
        });

        const correctionRow = adjusted.find((r) => r.date === ymd(2));
        expect(correctionRow).toBeDefined();
        expect(correctionRow!.adjusted).toBe(7);
        expect(lastClosing(adjusted)).toBe(12);
    });

    test('賞味期限21日(本番パス): 補正後に残った在庫も元の納品日基準で期限切れする', () => {
        // 25日前に MIX 30P 納品 → 23日前に実在庫 7P へ補正(ロス23)。
        // 残った 7P は元の納品日(25日前)+21日 = 4日前に期限切れ → 今日の在庫は 0。
        const shipments = [makeMixShipment(25, 30)];
        const sales: SalesReport[] = [];

        const adjusted = calculateFifoHistory(shipments, sales, 'mix', 21, 0, false, ymd(30), {
            date: ymd(23),
            targetStock: 7,
        });

        // 補正日(23日前): 在庫 7P に確定し、ロス -23 を計上
        const correctionRow = adjusted.find((r) => r.date === ymd(23));
        expect(correctionRow).toBeDefined();
        expect(correctionRow!.closingStock).toBe(7);
        expect(correctionRow!.adjusted).toBe(-23);

        // 4日前: 残り 7P が期限切れ（補正ロスとは別に「期限切れ」として計上）
        const expiryRow = adjusted.find((r) => r.date === ymd(4));
        expect(expiryRow).toBeDefined();
        expect(expiryRow!.expired).toBe(7);

        // 期限切れ後、最新在庫は 0
        expect(lastClosing(adjusted)).toBe(0);
    });

    test('補正なし(undefined)では従来挙動と完全に一致し adjusted は付かない', () => {
        const shipments = [makeMixShipment(5, 30)];
        const sales = [makeMixSale(1, 4)];

        const withUndefined = calculateFifoHistory(shipments, sales, 'mix', NO_EXPIRE, 0, false, ymd(10), undefined);
        const without = calculateFifoHistory(shipments, sales, 'mix', NO_EXPIRE, 0, false, ymd(10));

        expect(withUndefined).toEqual(without);
        // 30 - 4 = 26
        expect(lastClosing(withUndefined)).toBe(26);
        // adjusted フィールドはどの行にも付かない
        expect(withUndefined.every((r) => r.adjusted === undefined)).toBe(true);
    });
});
