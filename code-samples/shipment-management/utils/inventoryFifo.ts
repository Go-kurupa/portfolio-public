import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { type Shipment, type SalesReport } from '../types';
import { toDate, parseQuantity } from './shipmentHelpers';

dayjs.extend(utc);
dayjs.extend(timezone);

const JST = 'Asia/Tokyo';
const DAY_MS = 86400000;

/**
 * JST の YYYY-MM-DD を UTC ミリ秒から算出する（`dayjs().tz().format()` を介さない高速版）。
 * JST は固定オフセット(UTC+9)・DSTなしなので、+9h して UTC 日付を取れば JST 日付と一致する。
 * 日次ループ内で format を毎日呼ぶと Intl.DateTimeFormat が支配的コストになるため、ここを整数演算化する。
 */
const jstDateKey = (utcMillis: number): string => {
  const d = new Date(utcMillis + 9 * 3600000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
};

export interface DeliveryBatch {
  id: string;
  deliveryDayIdx: number; // startDay からの整数日数（賞味期限判定を dayjs.diff から整数引き算に置換）
  initialQty: number;
  remainingQty: number;
  soldQty: number;
  expiredQty: number;
  isFinished: boolean;
}

export interface FifoDailyResult {
  date: string;
  delivered: number;
  sold: number;
  expired: number;
  closingStock: number;
  adjusted?: number; // 実在庫手動補正による増減（負=ロス計上, 正=積み増し）。補正日の行にのみ付与
}

/** スナップショットに保存する活性バッチ（残数と納品日だけあれば以後の計算を再現できる）。 */
export interface FifoBatchSnapshot {
  deliveryDate: string; // 'YYYY-MM-DD'（JST）
  remainingQty: number;
}

/** スナップショットに保存する繰越台帳エントリ（時効判定に発生日が要る）。 */
export interface FifoCarryOverSnapshot {
  qty: number;
  sourceDate: string; // 'YYYY-MM-DD'（JST）
}

/**
 * 境界日 B 時点（B 当日の納品・消し込み・期限切れ・手動補正まで処理し終えた状態）の
 * FIFO 内部状態。これを initialState として渡せば「B+1 以降のデータだけ」で
 * 全期間計算と同じ結果が得られる（等価性は tests/inventoryFifo.snapshotEquivalence.test.ts で検証）。
 */
export interface FifoState {
  boundaryDate: string; // 'YYYY-MM-DD'（JST）。この日の処理後の状態であることを表す
  activeBatches: FifoBatchSnapshot[]; // FIFO 消化順（古い順）を保持したまま保存すること
  carryOverLedger: FifoCarryOverSnapshot[];
}

export interface FifoOptions {
  /**
   * 途中再開用の初期状態。指定した場合、計算開始日は **必ず** initialState.boundaryDate の
   * 翌日になる（historyStartDate は無視される）。スナップショットに含まれる期間を
   * 二重計算しないための規定。
   */
  initialState?: FifoState;
  /**
   * MAX_LOOKBACK_DAYS(400日) のクランプを無効化する。夜間バッチのみ true にする。
   * クランプが効いたままだと計算起点が実行日に引きずられ、スナップショット累計が
   * 日々ドリフトする（設計 H3）。既定 false = 現行のアプリ挙動。
   */
  disableLookbackClamp?: boolean;
}

interface FifoRunResult {
  history: FifoDailyResult[];
  /** captureAtDate を指定し、その日が計算範囲内にあった場合のみ非 null。 */
  capturedState: FifoState | null;
}

/**
 * 先入先出法(FIFO)に基づいた在庫計算エンジン
 *
 * historyStartDate (任意, 'YYYY-MM-DD'):
 *   指定があれば、その日からシミュレーションを開始する。UI 側の集計期間 (例: ダッシュボードの startDate)
 *   と FIFO の計算範囲を揃えるために使用。指定なしの場合は従来通り today から
 *   (shelfLife + grace + 30) 日前を startDay とする。
 *
 *   ★整合性の注意★
 *   集計範囲 (期間内納品/販売) と FIFO 範囲がずれると、 carryover (未消化売上) が消失して
 *   現在庫が過大計上される。 UI で「現在庫 = 期間内納品 - 期間内販売 - 廃棄」を成立させたい
 *   場合は必ず historyStartDate を渡すこと。
 *
 * ★性能★
 *   日次ループ内では dayjs を一切呼ばず、整数日数インデックスで回す。日付↔インデックスの変換は
 *   ループ外（startDay 計算・納品/売上の集計）に集約し、記録行の date 文字列のみ jstDateKey で生成する。
 *   これにより「店舗数 × 日数」の二重ループでも Intl.DateTimeFormat 呼び出しが激減する。
 */
const runFifo = (
  shipments: Shipment[],
  salesReports: SalesReport[],
  productType: 'p6' | 'p10' | 'mix',
  shelfLifeDays: number,
  gracePeriodDays: number,
  allowNegativeCarryOver: boolean,
  historyStartDate: string | undefined,
  manualAdjustment: { date: string; targetStock: number } | undefined,
  options: FifoOptions | undefined,
  captureAtDate: string | undefined
): FifoRunResult => {
  // 日本標準時(JST)で計算（実行環境のタイムゾーンに依存しないよう .tz(JST) を明示）
  const today = dayjs().tz(JST).startOf('day');
  const initialState = options?.initialState;

  // startDay の決定:
  // - initialState 指定あり: その boundaryDate の翌日から（スナップショット済み期間の二重計算を防ぐ）
  // - historyStartDate 指定あり: その日から (UI の集計期間と整合させる用途)
  //   ただし MAX_LOOKBACK_DAYS でクランプ。遠い過去 (例: 2020-01-01) を指定された時の
  //   日数ループ × 店舗数 × 商品種の暴走で UI フリーズすることを防ぐ
  //   （バッチ経路は disableLookbackClamp: true でクランプを外す）
  // - なし: today から (shelfLife + grace + safety) 日前 (従来挙動、後方互換)
  const MAX_LOOKBACK_DAYS = 400; // 1年超分の取引履歴を遡及できれば実用上十分
  let startDay: dayjs.Dayjs;
  if (initialState) {
    startDay = dayjs.tz(initialState.boundaryDate, JST).startOf('day').add(1, 'day');
  } else if (historyStartDate) {
    const requested = dayjs.tz(historyStartDate, JST).startOf('day');
    const earliest = today.subtract(MAX_LOOKBACK_DAYS, 'day');
    startDay =
      !options?.disableLookbackClamp && requested.isBefore(earliest) ? earliest : requested;
  } else {
    const SAFETY_MARGIN_DAYS = 30;
    const lookbackDays = shelfLifeDays + gracePeriodDays + SAFETY_MARGIN_DAYS;
    startDay = today.subtract(lookbackDays, 'day');
  }

  // ★ここから整数日数ベース★ startDay(=dayIdx 0) を基準に、日付は全て整数インデックスで扱う。
  const startDayMillis = startDay.valueOf();
  const totalDays = today.diff(startDay, 'day');
  // 任意の日付を startDay 起点の整数日数インデックスへ（JST startOf day 基準）。
  // JST固定オフセット(+9h)を足してから日数で floor すれば dayjs.tz を介さず同じ値が出る。
  const startJstEpochDay = Math.floor((startDayMillis + 9 * 3600000) / DAY_MS);
  const toDayIdx = (raw: unknown): number =>
    Math.floor((toDate(raw).getTime() + 9 * 3600000) / DAY_MS) - startJstEpochDay;

  // 納品データを「日数インデックス」ごとに集計（計算範囲外は除外して活発バッチが増えすぎないようにする）
  const deliveryMap = new Map<number, number>();
  shipments.forEach((s) => {
    if (s.status !== 'completed') return;
    const idx = toDayIdx(s.shipDate);
    if (idx < 0) return; // startDay より前は除外（旧 isBefore(startDay) と等価）
    const q = parseQuantity(s.details.quantity);
    const val = productType === 'p6' ? q.pack6 : productType === 'p10' ? q.pack10 : q.mix;
    deliveryMap.set(idx, (deliveryMap.get(idx) || 0) + val);
  });

  // 売上データを「日数インデックス」ごとに集計
  const salesMap = new Map<number, number>();
  salesReports.forEach((r) => {
    // 販売先Aの売上データは periodStart/periodEnd に日付が入っている
    // periodStart があれば販売日として最優先で採用（期間レポートの場合、開始日で消し込む）
    // periodStart がなければ r.date を使用（通常の日次レポート）
    const reportDate = r.periodStart || r.date || r.periodEnd;
    if (!reportDate) return;
    const idx = toDayIdx(reportDate);
    if (idx < 0) return;
    const val =
      productType === 'p6'
        ? r.breakdown_6pack || 0
        : productType === 'p10'
          ? r.breakdown_10pack || 0
          : r.breakdown_mix || 0;
    salesMap.set(idx, (salesMap.get(idx) || 0) + val);
  });

  // 手動補正日も日数インデックスへ事前変換（ループ内の日付文字列比較を避ける）
  const manualAdjustIdx = manualAdjustment
    ? dayjs.tz(manualAdjustment.date, JST).startOf('day').diff(startDay, 'day')
    : -1;

  const activeBatches: DeliveryBatch[] = [];
  const history: FifoDailyResult[] = [];
  // 在庫超過売上の繰越台帳。allowNegativeCarryOver = true の場合に使用。
  // 各エントリは sourceDayIdx (= phantom が発生した日数インデックス) を持ち、
  // shelfLife + grace を超えると時効消滅する (B0 段階)。
  // これがないと dead gap を越えた phantom 負債が未来の新規納品を侵食する
  // (販売先F 2026-06-18: 4ヶ月空白後の新品 18P が phantom 7P に食われ 5P 過少表示)。
  let carryOverLedger: { qty: number; sourceDayIdx: number }[] = [];

  // 途中再開: 境界日時点の状態を dayIdx 空間へ復元する。
  // deliveryDayIdx / sourceDayIdx は startDay より前になる（=負）が、判定は差分でしか
  // 使わないため負のままで正しく賞味期限・時効が効く。配列順 = FIFO 消化順を保持する。
  if (initialState) {
    initialState.activeBatches.forEach((b, i) => {
      if (b.remainingQty <= 0) return;
      activeBatches.push({
        id: `resume_${i}`,
        deliveryDayIdx: toDayIdx(b.deliveryDate),
        initialQty: b.remainingQty,
        remainingQty: b.remainingQty,
        soldQty: 0,
        expiredQty: 0,
        isFinished: false,
      });
    });
    carryOverLedger = initialState.carryOverLedger
      .filter((e) => e.qty > 0)
      .map((e) => ({ qty: e.qty, sourceDayIdx: toDayIdx(e.sourceDate) }));
  }

  // 状態捕捉日も日数インデックスへ（範囲外なら捕捉されず null のまま）
  const captureAtIdx = captureAtDate
    ? dayjs.tz(captureAtDate, JST).startOf('day').diff(startDay, 'day')
    : -1;
  let capturedState: FifoState | null = null;

  // 開始日(dayIdx=0)から今日(dayIdx=totalDays)まで1日ずつシミュレーション
  for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
    const dailyDelivered = deliveryMap.get(dayIdx) || 0;
    const dailySold = salesMap.get(dayIdx) || 0;
    let dailyExpired = 0;

    // A. 納品処理: 新しいバッチを追加
    if (dailyDelivered > 0) {
      activeBatches.push({
        id: `${dayIdx}_${Math.random().toString(36).substr(2, 5)}`,
        deliveryDayIdx: dayIdx,
        initialQty: dailyDelivered,
        remainingQty: dailyDelivered,
        soldQty: 0,
        expiredQty: 0,
        isFinished: false,
      });
    }

    // B0. 繰越台帳の時効処理
    // shelfLife + grace 経過した phantom は「過去に未集計の納品があった可能性」を諦めて消滅。
    if (carryOverLedger.length > 0) {
      const ageLimit = shelfLifeDays + gracePeriodDays;
      carryOverLedger = carryOverLedger.filter((e) => dayIdx - e.sourceDayIdx < ageLimit);
    }

    // B. 売上消し込み処理 (FIFO: 古いバッチから順に引く)
    // 古い繰越 → 今日の売上 の優先順で活性バッチから消化する。
    // 各 ledger エントリを独立に消化することで、エントリごとに時効カウントを保持する。
    for (const entry of carryOverLedger) {
      let entryRemaining = entry.qty;
      for (const batch of activeBatches) {
        if (entryRemaining <= 0) break;
        if (batch.isFinished) continue;
        const take = Math.min(batch.remainingQty, entryRemaining);
        batch.remainingQty -= take;
        batch.soldQty += take;
        entryRemaining -= take;
        if (batch.remainingQty <= 0) batch.isFinished = true;
      }
      entry.qty = entryRemaining;
    }
    carryOverLedger = carryOverLedger.filter((e) => e.qty > 0);

    let remainingSales = dailySold;
    for (const batch of activeBatches) {
      if (remainingSales <= 0) break;
      if (batch.isFinished) continue;
      const take = Math.min(batch.remainingQty, remainingSales);
      batch.remainingQty -= take;
      batch.soldQty += take;
      remainingSales -= take;
      if (batch.remainingQty <= 0) batch.isFinished = true;
    }

    // 今日の売上で在庫を超えた分は新規エントリとして繰越台帳に追加 (sourceDayIdx=dayIdx)
    if (remainingSales > 0 && allowNegativeCarryOver) {
      carryOverLedger.push({ qty: remainingSales, sourceDayIdx: dayIdx });
    }

    // C. 賞味期限切れチェック (納品日から指定日数 + 猶予期間経過)。整数日数の差で判定。
    activeBatches.forEach((batch) => {
      if (!batch.isFinished && dayIdx - batch.deliveryDayIdx >= shelfLifeDays + gracePeriodDays) {
        dailyExpired += batch.remainingQty;
        batch.expiredQty = batch.remainingQty;
        batch.remainingQty = 0;
        batch.isFinished = true;
      }
    });

    // D. 実在庫手動補正: 補正日にFIFO計算上の在庫を実在庫へ確定させる。
    //    不足(計算 > 実在庫)なら最古バッチからロスとして除去し、超過(実在庫 > 計算)なら
    //    補正日付の新規バッチとして積み増す。いずれも activeBatches を直接書き換えるため、
    //    以降の日は補正後の在庫を起点に FIFO を継続する（＝繰り越し）。
    //    フラットなオフセットと違い、ゴースト在庫を将来の売上/期限切れで二重計上しない。
    let dailyAdjusted = 0;
    if (manualAdjustment && dayIdx === manualAdjustIdx) {
      const stockBeforeAdjust = activeBatches.reduce((sum, b) => sum + b.remainingQty, 0);
      const targetStock = manualAdjustment.targetStock;
      let lossToRemove = stockBeforeAdjust - targetStock;
      if (lossToRemove > 0) {
        // 計算 > 実在庫: 最古バッチ(FIFO: 先に期限切れになる側)からロス除去
        for (const batch of activeBatches) {
          if (lossToRemove <= 0) break;
          if (batch.isFinished) continue;
          const take = Math.min(batch.remainingQty, lossToRemove);
          batch.remainingQty -= take;
          lossToRemove -= take;
          if (batch.remainingQty <= 0) batch.isFinished = true;
        }
      } else if (lossToRemove < 0) {
        // 実在庫 > 計算: 不足分を補正日の新規バッチとして積み増す(期限は補正日起点)
        const addQty = -lossToRemove;
        activeBatches.push({
          id: `${dayIdx}_adjust`,
          deliveryDayIdx: dayIdx,
          initialQty: addQty,
          remainingQty: addQty,
          soldQty: 0,
          expiredQty: 0,
          isFinished: false,
        });
      }
      dailyAdjusted = targetStock - stockBeforeAdjust; // 負=ロス, 正=積み増し
    }

    // 走査コスト削減: 消化済み/期限切れ(remainingQty=0, isFinished)のバッチを除去。
    // 売上消し込み・賞味期限・closingStock はいずれも finished を無視するので出力に影響しない。
    // これで activeBatches が日数に比例して肥大せず「賞味期限の窓ぶん」に保たれる（日が経っても重くならない）。
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < activeBatches.length; readIdx++) {
      if (!activeBatches[readIdx].isFinished) activeBatches[writeIdx++] = activeBatches[readIdx];
    }
    activeBatches.length = writeIdx;

    const closingStock = activeBatches.reduce((sum, b) => sum + b.remainingQty, 0);

    // 動きがあった日、または在庫がある日、または補正があった日を記録
    if (
      dailyDelivered > 0 ||
      dailySold > 0 ||
      dailyExpired > 0 ||
      closingStock > 0 ||
      dailyAdjusted !== 0
    ) {
      history.push({
        date: jstDateKey(startDayMillis + dayIdx * DAY_MS),
        delivered: dailyDelivered,
        sold: dailySold,
        expired: dailyExpired,
        closingStock: closingStock,
        ...(dailyAdjusted !== 0 ? { adjusted: dailyAdjusted } : {}),
      });
    }

    // 状態捕捉: 境界日 B の「当日処理後」（納品・消し込み・期限切れ・手動補正・
    // 消化済みバッチ除去まで完了した時点）の状態を写し取る。設計の帰属定義表の
    // 「出荷 shipDate <= B はスナップショット側」に対応する位置。
    if (captureAtDate && dayIdx === captureAtIdx) {
      capturedState = {
        boundaryDate: captureAtDate,
        activeBatches: activeBatches.map((b) => ({
          deliveryDate: jstDateKey(startDayMillis + b.deliveryDayIdx * DAY_MS),
          remainingQty: b.remainingQty,
        })),
        carryOverLedger: carryOverLedger.map((e) => ({
          qty: e.qty,
          sourceDate: jstDateKey(startDayMillis + e.sourceDayIdx * DAY_MS),
        })),
      };
    }
  }

  return { history, capturedState };
};

export const calculateFifoHistory = (
  shipments: Shipment[],
  salesReports: SalesReport[],
  productType: 'p6' | 'p10' | 'mix',
  shelfLifeDays: number = 21,
  gracePeriodDays: number = 0, // 猶予期間（週次レポートなどで売上計上が遅れる場合のバッファ）
  allowNegativeCarryOver: boolean = false, // 未消化の売上を繰り越して未来の納品から消し込むか
  historyStartDate?: string, // 'YYYY-MM-DD' 形式。指定があれば lookback ではなくこの日から計算
  manualAdjustment?: { date: string; targetStock: number }, // 実在庫手動補正。補正日(JST 'YYYY-MM-DD')にFIFO在庫を実在庫へ確定し、差分をロス/積増として計上。以降はその在庫を起点に繰り越す
  options?: FifoOptions // 途中再開・クランプ無効化（未指定なら従来どおりの挙動）
): FifoDailyResult[] =>
  runFifo(
    shipments,
    salesReports,
    productType,
    shelfLifeDays,
    gracePeriodDays,
    allowNegativeCarryOver,
    historyStartDate,
    manualAdjustment,
    options,
    undefined
  ).history;

/**
 * 境界日 boundaryDate 時点の FIFO 内部状態を捕捉する（夜間バッチ専用）。
 *
 * 返す history は calculateFifoHistory と完全に同一（同じ 1 本のループから返す）ため、
 * 「捕捉のために別ロジックを書いたせいで値がずれる」ことが構造的に起きない。
 * boundaryDate が計算範囲外（開始日より前 / 今日より後）の場合 state は null。
 */
export const captureFifoStateAt = (
  shipments: Shipment[],
  salesReports: SalesReport[],
  productType: 'p6' | 'p10' | 'mix',
  boundaryDate: string,
  shelfLifeDays: number = 21,
  gracePeriodDays: number = 0,
  allowNegativeCarryOver: boolean = false,
  historyStartDate?: string,
  options?: FifoOptions
): { state: FifoState | null; history: FifoDailyResult[] } => {
  const result = runFifo(
    shipments,
    salesReports,
    productType,
    shelfLifeDays,
    gracePeriodDays,
    allowNegativeCarryOver,
    historyStartDate,
    undefined,
    options,
    boundaryDate
  );
  return { state: result.capturedState, history: result.history };
};
