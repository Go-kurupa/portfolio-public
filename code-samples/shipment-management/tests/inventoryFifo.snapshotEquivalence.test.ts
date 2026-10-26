/**
 * FIFO スナップショット等価性テスト（設計「正しさの検証」の本丸）
 *
 * 「全期間を calculateFifoHistory で計算した結果」と
 * 「境界日 B で captureFifoStateAt → initialState 再開で計算した結果」が
 * 完全一致することを、境界前後の分布を網羅した固定ケース群で検証する。
 *
 * 日付は today からの相対で組み立てる（calculateFifoHistory が内部で dayjs() を
 * 呼ぶため、絶対日付にすると「今日」との位置関係が日々変わってしまう）。
 */
import { describe, expect, it } from '@jest/globals';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import {
  calculateFifoHistory,
  captureFifoStateAt,
  type FifoDailyResult,
} from '../utils/inventoryFifo';
import type { SalesReport, Shipment } from '../types';

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = 'Asia/Tokyo';

/** 今日(JST)から n 日前の 'YYYY-MM-DD' */
const daysAgo = (n: number): string =>
  dayjs().tz(JST).startOf('day').subtract(n, 'day').format('YYYY-MM-DD');

/** 'YYYY-MM-DD'(JST 0時) を Firestore Timestamp 互換の { toDate } に変換 */
const ts = (dateKey: string): { toDate: () => Date } => {
  const d = dayjs.tz(dateKey, JST).startOf('day').toDate();
  return { toDate: () => d };
};

const shipment = (dateKey: string, pack6: number, pack10: number): Shipment =>
  ({
    id: `ship_${dateKey}_${pack6}_${pack10}`,
    registrationType: 'serif',
    shipDate: ts(dateKey),
    createdAt: ts(dateKey),
    details: { clientId: 'c1', quantity: { pack6, pack10 } },
    status: 'completed',
  }) as unknown as Shipment;

/** 日次レポート（periodStart = periodEnd = 当日） */
const dailySale = (dateKey: string, pack6: number, pack10: number): SalesReport =>
  ({
    id: `sale_${dateKey}`,
    date: ts(dateKey),
    quantity: pack6 + pack10,
    breakdown_6pack: pack6,
    breakdown_10pack: pack10,
    periodStart: ts(dateKey),
    periodEnd: ts(dateKey),
  }) as unknown as SalesReport;

/** 期間レポート（週次など）。FIFO 帰属日は periodStart。 */
const periodSale = (startKey: string, endKey: string, pack6: number, pack10: number): SalesReport =>
  ({
    id: `sale_${startKey}_${endKey}`,
    date: ts(endKey),
    quantity: pack6 + pack10,
    breakdown_6pack: pack6,
    breakdown_10pack: pack10,
    periodStart: ts(startKey),
    periodEnd: ts(endKey),
  }) as unknown as SalesReport;

interface EquivalenceCase {
  name: string;
  shipments: Shipment[];
  sales: SalesReport[];
  boundaryDaysAgo: number;
  shelfLife: number;
  grace: number;
  allowNegativeCarryOver: boolean;
  startDaysAgo: number;
}

const CASES: EquivalenceCase[] = [
  {
    // 販売先Aの実運用パラメータ（賞味期限19日 + 猶予7日 + マイナス繰越あり）。
    // 境界の前後に納品・販売・期限切れが分布するよう配置。
    name: '基本: 境界前後に納品と販売が分布する',
    shipments: [
      shipment(daysAgo(60), 10, 6),
      shipment(daysAgo(40), 8, 4),
      shipment(daysAgo(31), 5, 5), // 境界の1日前
      shipment(daysAgo(30), 7, 3), // 境界当日（= スナップショット側）
      shipment(daysAgo(29), 6, 2), // 境界の翌日（= 窓側）
      shipment(daysAgo(10), 9, 5),
      shipment(daysAgo(1), 4, 4),
    ],
    sales: [
      dailySale(daysAgo(55), 3, 2),
      dailySale(daysAgo(38), 4, 1),
      dailySale(daysAgo(30), 2, 2), // 境界当日の販売
      dailySale(daysAgo(29), 3, 1), // 境界翌日の販売
      dailySale(daysAgo(8), 5, 3),
      dailySale(daysAgo(2), 2, 1),
    ],
    boundaryDaysAgo: 30,
    shelfLife: 19,
    grace: 7,
    allowNegativeCarryOver: true,
    startDaysAgo: 90,
  },
  {
    // 期間レポートが境界を跨ぐケース（設計で必須指定）。
    // periodStart <= B < periodEnd → FIFO 帰属はスナップショット側になるのが正。
    name: '境界跨ぎ期間レポート（週次形式）',
    shipments: [
      shipment(daysAgo(50), 12, 8),
      shipment(daysAgo(33), 6, 6),
      shipment(daysAgo(28), 10, 4),
      shipment(daysAgo(5), 8, 2),
    ],
    sales: [
      periodSale(daysAgo(34), daysAgo(28), 5, 3), // 境界(30日前)を跨ぐ週次
      periodSale(daysAgo(27), daysAgo(21), 6, 4),
      periodSale(daysAgo(31), daysAgo(25), 4, 2), // もう1本の跨ぎ
      dailySale(daysAgo(3), 3, 1),
    ],
    boundaryDaysAgo: 30,
    shelfLife: 19,
    grace: 7,
    allowNegativeCarryOver: true,
    startDaysAgo: 90,
  },
  {
    // 在庫を超える販売 → 負の繰越が境界を跨いで生き残り、境界後の納品を侵食する。
    name: '負繰越が境界を跨ぐ',
    shipments: [shipment(daysAgo(45), 3, 1), shipment(daysAgo(20), 20, 10)],
    sales: [
      dailySale(daysAgo(44), 10, 5), // 在庫超過 → 繰越発生
      dailySale(daysAgo(32), 4, 2), // 境界前にもう一度超過
      dailySale(daysAgo(19), 2, 1),
    ],
    boundaryDaysAgo: 30,
    shelfLife: 19,
    grace: 7,
    allowNegativeCarryOver: true,
    startDaysAgo: 90,
  },
  {
    // 賞味期限切れが境界当日 / 境界翌日にちょうど来る配置（off-by-one 検出用）。
    // shelfLife+grace = 26 日なので、26日前の納品は境界(30日前)より後に期限を迎える。
    name: '期限切れが境界の直前・当日・直後に来る',
    shipments: [
      shipment(daysAgo(56), 10, 10), // 期限 = 30日前（境界当日に失効）
      shipment(daysAgo(55), 8, 8), // 期限 = 29日前（境界翌日に失効）
      shipment(daysAgo(57), 6, 6), // 期限 = 31日前（境界前日に失効）
      shipment(daysAgo(26), 5, 5), // 期限 = 今日
    ],
    sales: [dailySale(daysAgo(50), 1, 1)],
    boundaryDaysAgo: 30,
    shelfLife: 19,
    grace: 7,
    allowNegativeCarryOver: true,
    startDaysAgo: 90,
  },
  {
    // 4店舗アラートのパラメータ（賞味期限21日・猶予0・繰越なし）でも一致すること。
    name: '4店舗パラメータ（shelfLife=21 / grace=0 / 繰越なし）',
    shipments: [
      shipment(daysAgo(40), 6, 3),
      shipment(daysAgo(25), 4, 4),
      shipment(daysAgo(3), 5, 5),
    ],
    sales: [
      dailySale(daysAgo(39), 2, 1),
      dailySale(daysAgo(24), 3, 2),
      dailySale(daysAgo(1), 1, 1),
    ],
    boundaryDaysAgo: 30,
    shelfLife: 21,
    grace: 0,
    allowNegativeCarryOver: false,
    startDaysAgo: 90,
  },
  {
    name: 'データが空',
    shipments: [],
    sales: [],
    boundaryDaysAgo: 30,
    shelfLife: 19,
    grace: 7,
    allowNegativeCarryOver: true,
    startDaysAgo: 90,
  },
  {
    // 境界より後にしかデータが無い（新規取扱店）。
    name: '境界より後にしかデータが無い',
    shipments: [shipment(daysAgo(12), 10, 5)],
    sales: [dailySale(daysAgo(9), 4, 2)],
    boundaryDaysAgo: 30,
    shelfLife: 19,
    grace: 7,
    allowNegativeCarryOver: true,
    startDaysAgo: 90,
  },
];

const PRODUCT_TYPES = ['p6', 'p10'] as const;

/** 境界日より後の日次行だけを取り出す（窓側の比較対象） */
const rowsAfter = (history: FifoDailyResult[], boundaryDate: string): FifoDailyResult[] =>
  history.filter((row) => row.date > boundaryDate);

describe('FIFO スナップショット等価性（全期間計算 === 捕捉 + 再開計算）', () => {
  for (const testCase of CASES) {
    for (const productType of PRODUCT_TYPES) {
      it(`${testCase.name} / ${productType}`, () => {
        const boundaryDate = daysAgo(testCase.boundaryDaysAgo);
        const startDate = daysAgo(testCase.startDaysAgo);

        // ① 全期間計算（現行のアプリと同じ呼び方）
        const fullHistory = calculateFifoHistory(
          testCase.shipments,
          testCase.sales,
          productType,
          testCase.shelfLife,
          testCase.grace,
          testCase.allowNegativeCarryOver,
          startDate
        );

        // ② 境界日で状態を捕捉（バッチがやること）
        const captured = captureFifoStateAt(
          testCase.shipments,
          testCase.sales,
          productType,
          boundaryDate,
          testCase.shelfLife,
          testCase.grace,
          testCase.allowNegativeCarryOver,
          startDate
        );
        expect(captured.state).not.toBeNull();
        // 捕捉と同時に返る history は全期間計算と完全一致（同一ループ由来）
        expect(captured.history).toEqual(fullHistory);

        // ③ Firestore 往復を模した JSON シリアライズ（型と丸めの担保）
        const roundTripped = JSON.parse(JSON.stringify(captured.state));

        // ④ スナップショット状態 + 境界より後のデータだけで再開（クライアントがやること）
        const windowShipments = testCase.shipments.filter(
          (s) => dayjs(s.shipDate.toDate()).tz(JST).format('YYYY-MM-DD') > boundaryDate
        );
        // 売上は設計どおり periodEnd > B（上位集合）で取得したものをそのまま渡す。
        // 帰属日 <= B の分は FIFO 側で開始日より前として除外される。
        const windowSales = testCase.sales.filter(
          (r) => dayjs(r.periodEnd!.toDate()).tz(JST).format('YYYY-MM-DD') > boundaryDate
        );
        const resumedHistory = calculateFifoHistory(
          windowShipments,
          windowSales,
          productType,
          testCase.shelfLife,
          testCase.grace,
          testCase.allowNegativeCarryOver,
          undefined,
          undefined,
          { initialState: roundTripped }
        );

        // ⑤ 日次行が完全一致（境界より後の全期間行 === 再開計算の全行）
        expect(resumedHistory).toEqual(rowsAfter(fullHistory, boundaryDate));

        // ⑥ 最終在庫が一致（アラート判定が読む値）
        const lastStock = (history: FifoDailyResult[]): number =>
          history.length > 0 ? history[history.length - 1].closingStock : 0;
        expect(lastStock(resumedHistory)).toBe(lastStock(fullHistory));

        // ⑦ 境界より後の廃棄累計が一致（完売率の分母）
        const sumExpired = (history: FifoDailyResult[]): number =>
          history.reduce((sum, row) => sum + row.expired, 0);
        expect(sumExpired(resumedHistory)).toBe(sumExpired(rowsAfter(fullHistory, boundaryDate)));
      });
    }
  }
});

describe('captureFifoStateAt の境界条件', () => {
  it('境界日が計算範囲より前なら state は null（バッチ側で異常検知できる）', () => {
    const captured = captureFifoStateAt(
      [shipment(daysAgo(10), 5, 5)],
      [],
      'p6',
      daysAgo(200),
      19,
      7,
      true,
      daysAgo(90)
    );
    expect(captured.state).toBeNull();
  });

  it('境界日が未来なら state は null', () => {
    const future = dayjs().tz(JST).add(3, 'day').format('YYYY-MM-DD');
    const captured = captureFifoStateAt(
      [shipment(daysAgo(10), 5, 5)],
      [],
      'p6',
      future,
      19,
      7,
      true,
      daysAgo(90)
    );
    expect(captured.state).toBeNull();
  });

  it('捕捉した活性バッチは FIFO 消化順（納品日昇順）を保つ', () => {
    const captured = captureFifoStateAt(
      [shipment(daysAgo(40), 5, 0), shipment(daysAgo(35), 7, 0), shipment(daysAgo(33), 2, 0)],
      [],
      'p6',
      daysAgo(30),
      19,
      7,
      true,
      daysAgo(90)
    );
    const dates = captured.state!.activeBatches.map((b) => b.deliveryDate);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('disableLookbackClamp（設計 H3: バッチ経路のみクランプ回避）', () => {
  const farPast = daysAgo(500);
  const clampEdge = daysAgo(400);
  const shipments = [
    shipment(daysAgo(480), 4, 0), // クランプが効くと計算範囲外に落ちる納品
    shipment(daysAgo(2), 3, 0),
  ];

  it('既定（オプション未指定）では 400 日クランプが効き、500日前の指定は 400日前に丸められる', () => {
    const history = calculateFifoHistory(shipments, [], 'p6', 19, 7, true, farPast);
    expect(history.length).toBeGreaterThan(0);
    // 400日クランプ後の開始日より前の行は存在しない
    expect(history[0].date >= clampEdge).toBe(true);
  });

  it('disableLookbackClamp: true では 500 日前から計算される', () => {
    const history = calculateFifoHistory(shipments, [], 'p6', 19, 7, true, farPast, undefined, {
      disableLookbackClamp: true,
    });
    expect(history.length).toBeGreaterThan(0);
    // 480日前の納品行が現れる = クランプされていない
    expect(history[0].date).toBe(daysAgo(480));
    expect(history[0].delivered).toBe(4);
  });
});
