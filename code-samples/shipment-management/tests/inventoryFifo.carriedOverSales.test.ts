import { describe, test, expect } from '@jest/globals';
import dayjs from 'dayjs';
import { Timestamp } from 'firebase/firestore';
import { calculateFifoHistory } from '../utils/inventoryFifo';
import type { Shipment, SalesReport } from '../types';

// allowNegativeCarryOver = true の繰越売上 (phantom) が、
// shelfLife + grace を超えて残り続け未来の新規納品を食い続ける不具合の回帰テスト。
// 販売先F (2026-06-18) で長期 dead gap 越しに 7 パック過少表示が発生したのが発端。

const ymd = (daysAgo: number): string =>
    dayjs().subtract(daysAgo, 'day').format('YYYY-MM-DD');

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

describe('calculateFifoHistory — carryOverSales 時効処理 (allowNegativeCarryOver=true)', () => {
    test('shelfLife+grace 経過した phantom 繰越は未来の新規納品を侵食しない', () => {
        // shelfLife=19 + grace=7 = 26 日で時効。
        // 50日前に売上 2P (在庫なし→phantom 発生) → 10日前に新規納品 10P。
        // phantom 発生から納品までの経過 = 40 日 > 26 日 → 既に時効済みのはず。
        const sales = [makeMixSale(50, 2)];
        const shipments = [makeMixShipment(10, 10)];

        const history = calculateFifoHistory(
            shipments,
            sales,
            'mix',
            19,
            7,
            true,
            ymd(60),
        );

        // 期待: phantom が時効済みなので新規納品 10P 丸ごと残る
        expect(lastClosing(history)).toBe(10);
    });

    test('shelfLife+grace 期間内の phantom 繰越は未来の新規納品を消化する (既存挙動を維持)', () => {
        // shelfLife=19 + grace=7 = 26 日で時効。
        // 20日前に売上 2P (phantom 発生) → 5日前に新規納品 10P。
        // phantom 発生から納品までの経過 = 15 日 < 26 日 → まだ時効内。
        const sales = [makeMixSale(20, 2)];
        const shipments = [makeMixShipment(5, 10)];

        const history = calculateFifoHistory(
            shipments,
            sales,
            'mix',
            19,
            7,
            true,
            ymd(30),
        );

        // 期待: phantom 2P が新規納品 10P から消化される → 残 8P
        expect(lastClosing(history)).toBe(8);
    });
});
