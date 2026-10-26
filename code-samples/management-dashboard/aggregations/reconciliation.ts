import type { FreeeIncomeDealsDoc } from '../freee/incomeTypes';
import type {
  ChannelCloseDoc,
  CloseOverride,
  MatchResult,
  MatchedPayment,
  MonthlyCloseStatus,
  MonthlyPlSummary,
  ReconciliationEntry,
} from '../types/facts';
import { resolveClosedChannelNet } from './closedSalesDisplay';

export interface SettlementCycleBound {
  /** 対象月からのオフセット月数（0 = 対象月そのもの、1 = 翌月） */
  readonly offsetMonths: number;
  /** 日。'end' はその月の末日 */
  readonly day: number | 'end';
}

export interface SettlementCycle {
  readonly start: SettlementCycleBound;
  readonly end: SettlementCycleBound;
}

/** 既定: 対象月 M の売上は M+1 月中に入金される */
export const SETTLEMENT_DEFAULT_CYCLE: SettlementCycle = {
  start: { offsetMonths: 1, day: 1 },
  end: { offsetMonths: 1, day: 'end' },
};

/**
 * 委託先ごとの入金サイクル。
 * 販売先Dは半月締め・月2回払い（M月前半の売上 → 同月18〜20日 / M月後半の売上 → 翌月3〜8日）。
 * freee 2026-04/05/06 の実データ照合で split_day=16 が唯一の最適解だった（2026-07-29 調査）。
 */
export const SETTLEMENT_CYCLE_BY_CLOSE_KEY: Readonly<Record<string, SettlementCycle>> = {
  samplePartyA: {
    start: { offsetMonths: 0, day: 16 },
    end: { offsetMonths: 1, day: 15 },
  },
};

export interface SettlementDateRange {
  /** inclusive・YYYY-MM-DD */
  readonly startDate: string;
  /** inclusive・YYYY-MM-DD */
  readonly endDate: string;
}

// 自動突合(auto)を成立させる許容誤差。差が「売上額の AUTO_MATCH_RATE 以内」かつ
// 「AUTO_MATCH_ABS 円以内」の両方を満たしたときだけ自動一致にする。
//
// 2026-08-20 に 1%/¥1,000 から 3%/¥3,000 へ緩和（オーナー判断）。委託先の入金は
// 手数料の端数・半月境界の日ずれで数千円規模の差が日常的に出るため、旧値では
// 実運用で毎月「要確認」になり手作業が発生していた（販売先D 2026-06: 売上¥XX,XXX に対し
// 入金合計¥YY,YYY＝差¥Z,ZZZ＝2.3%）。一方で「1万円単位の欠損」「桁違いの振込」は
// 引き続き止めたいので、上限そのものは撤廃せず広げるに留めている。
export const AUTO_MATCH_RATE = 0.03;
export const AUTO_MATCH_ABS = 3000;

/**
 * 金額が一致していても自動突合(auto)にせず、必ず人の確認(needs_review)を要求する締めキー。
 *
 * 販売先D（2 店舗）は2026-07-30時点では候補入金の抽出期間がまだ「翌月・上限あり」の
 * 単純な窓で、半月締め・月2回払いのサイクルを正しく捉えられていなかったため、誤った入金と
 * 紐付くのを防ぐ暫定策としてここに入れていた。同日中の後続修正で
 * SETTLEMENT_CYCLE_BY_CLOSE_KEY により候補窓を半月境界(M/16〜M+1/15)に直したことで
 * 候補が正しく絞り込めるようになったため、2026-08-20 に突合対象へ戻した
 * （毎月2回のサイクルが周期的に正しく絞れるなら自動ではめこんでよいという経営者判断）。
 *
 * ⚠️ ここに追加した締めキーは金額が一致していても必ず needs_review になる。
 */
export const AUTO_MATCH_EXCLUDED_CLOSE_KEYS: readonly string[] = [];
const AUTO_MATCH_EXCLUDED_CLOSE_KEY_SET: ReadonlySet<string> = new Set(
  AUTO_MATCH_EXCLUDED_CLOSE_KEYS
);

/**
 * 入金突合の対象外にする締めキー。
 *
 * 取引先Cは 2026-08-05 時点では「アプリ側の内訳が販売形態（定期配送 / ふるさと納税 /
 * 店舗・卸 / 単発購入）で freee 側取引先と 1:1 対応が作れない」として除外していたが、
 * 個別の取引先名を含む具体例は、この提出用コピーでは省略。
 * 判明したため、2026-08-20 に突合対象へ変更（除外リストから削除）した。
 * `freee_partner_close_keys` に対応表が未登録の間は unmapped（未対応）として出るのが
 * 正しい挙動で、登録は経営者が画面から行う。
 *
 * ⚠️ ここに追加した締めキーは freee 実入金による確定の対象から永久に外れる。
 *    その販路の売上は概算のまま残る。追加するときは経営者の判断を仰ぐこと。
 */
export const RECONCILIATION_EXCLUDED_CLOSE_KEYS: readonly string[] = [];
const RECONCILIATION_EXCLUDED_CLOSE_KEY_SET: ReadonlySet<string> = new Set(
  RECONCILIATION_EXCLUDED_CLOSE_KEYS
);

/**
 * 入金額と金額突合できない締めキー。
 *
 * 買い切りはアプリ側が請求書の卵代（税・送料を除く）、freee 側の入金候補が
 * 振込額（税・送料込み）で物差しが違うため、金額比較が原理的に成立しない。
 * 入金確認は締めカードの請求書消込ベース表示が担う。
 *
 * ⚠️ 対応表の closeKeyOptions からは外さない。買い切りの確定額計算がその対応表に
 *    依存するため、RECONCILIATION_EXCLUDED_CLOSE_KEYS には絶対に追加しないこと。
 */
export const AMOUNT_MATCH_INCOMPARABLE_CLOSE_KEYS: readonly string[] = ['kaikiri'];
const AMOUNT_MATCH_INCOMPARABLE_CLOSE_KEY_SET: ReadonlySet<string> = new Set(
  AMOUNT_MATCH_INCOMPARABLE_CLOSE_KEYS
);

/** 取引先(partnerId)単位の入金内訳。締める前に「どの取引先の入金が確認できているか」を判断する材料。 */
export interface PartnerSettlementBreakdown {
  readonly partnerId: number;
  /** freee 上の取引先表示名スナップショット（IncomeDeal.partnerName 由来）。 */
  readonly partnerName: string;
  readonly total: number;
  readonly lastPaymentDate: string | null;
  readonly dealCount: number;
}

export interface SettlementSummary {
  readonly settledPaymentsTotal: number;
  readonly lastPaymentDate: string | null;
  readonly dealCount: number;
  /** 内訳は入金合計の降順。同額なら partnerId 昇順で安定させる。 */
  readonly partnerBreakdown: readonly PartnerSettlementBreakdown[];
}

export interface PlDisplay {
  readonly profitValue: number | null;
  readonly badge: 'estimate' | 'confirmed';
  readonly source: string;
}

export function resolvePlDisplay(
  plSummary: Pick<MonthlyPlSummary, 'cashRevenueTotal' | 'cashExpenseTotal' | 'profit'> | null,
  monthStatus: Pick<MonthlyCloseStatus, 'plConfirmedAt'> | null
): PlDisplay {
  if (
    monthStatus?.plConfirmedAt != null &&
    plSummary !== null &&
    plSummary.cashRevenueTotal !== null &&
    plSummary.cashExpenseTotal !== null
  ) {
    return {
      profitValue: plSummary.cashRevenueTotal - plSummary.cashExpenseTotal,
      badge: 'confirmed',
      source: 'freee_cash',
    };
  }

  return {
    profitValue: plSummary?.profit.value ?? null,
    badge: 'estimate',
    source: 'consumption',
  };
}

function mergeLastPaymentDate(current: string | null, next: string | null): string | null {
  if (current === null) return next;
  if (next === null) return current;
  return next > current ? next : current;
}

export function summarizeSettlements(
  dealsDocs: readonly FreeeIncomeDealsDoc[],
  closeKeyByPartnerId: ReadonlyMap<number, string>,
  rangeByCloseKey: Readonly<Record<string, SettlementDateRange>>
): Record<string, SettlementSummary> {
  const totalsByCloseKey = new Map<
    string,
    { settledPaymentsTotal: number; lastPaymentDate: string | null; dealCount: number }
  >();
  // partnerId 単位の内訳は closeKey ごとにネストして持つ。
  const breakdownByCloseKey = new Map<string, Map<number, PartnerSettlementBreakdown>>();

  for (const doc of dealsDocs) {
    for (const deal of doc.deals) {
      if (deal.status !== 'settled' || deal.partnerId === null) continue;
      const closeKey = closeKeyByPartnerId.get(deal.partnerId);
      if (closeKey === undefined) continue;
      const range = rangeByCloseKey[closeKey];
      if (range === undefined) continue;

      const inRangePayments = deal.payments.filter((payment) =>
        isWithinSettlementDateRange(payment.date, range)
      );
      if (inRangePayments.length === 0) continue;

      const paymentsTotal = inRangePayments.reduce((sum, payment) => sum + payment.amount, 0);
      const lastPaymentDate = inRangePayments.reduce<string | null>((latest, payment) => {
        if (latest === null || payment.date > latest) return payment.date;
        return latest;
      }, null);

      const currentTotal = totalsByCloseKey.get(closeKey) ?? {
        settledPaymentsTotal: 0,
        lastPaymentDate: null,
        dealCount: 0,
      };
      totalsByCloseKey.set(closeKey, {
        settledPaymentsTotal: currentTotal.settledPaymentsTotal + paymentsTotal,
        lastPaymentDate: mergeLastPaymentDate(currentTotal.lastPaymentDate, lastPaymentDate),
        dealCount: currentTotal.dealCount + 1,
      });

      const partnerMap =
        breakdownByCloseKey.get(closeKey) ?? new Map<number, PartnerSettlementBreakdown>();
      const currentPartner = partnerMap.get(deal.partnerId) ?? {
        partnerId: deal.partnerId,
        partnerName: deal.partnerName,
        total: 0,
        lastPaymentDate: null,
        dealCount: 0,
      };
      partnerMap.set(deal.partnerId, {
        partnerId: deal.partnerId,
        // 表示名は取引先ごとに変わらない想定だが、空文字より新しい非空値を優先する。
        partnerName: deal.partnerName !== '' ? deal.partnerName : currentPartner.partnerName,
        total: currentPartner.total + paymentsTotal,
        lastPaymentDate: mergeLastPaymentDate(currentPartner.lastPaymentDate, lastPaymentDate),
        dealCount: currentPartner.dealCount + 1,
      });
      breakdownByCloseKey.set(closeKey, partnerMap);
    }
  }

  const summaries: Record<string, SettlementSummary> = {};
  for (const [closeKey, total] of totalsByCloseKey) {
    const partnerBreakdown = [...(breakdownByCloseKey.get(closeKey)?.values() ?? [])].sort(
      (a, b) => b.total - a.total || a.partnerId - b.partnerId
    );
    summaries[closeKey] = { ...total, partnerBreakdown };
  }

  return summaries;
}

export function buildMatchedPaymentCandidates(
  dealsDocs: readonly FreeeIncomeDealsDoc[],
  freeePartnerIds: readonly number[],
  range: SettlementDateRange
): MatchedPayment[] {
  const targetPartnerIds = new Set(freeePartnerIds);
  const candidates: MatchedPayment[] = [];

  for (const doc of dealsDocs) {
    for (const deal of doc.deals) {
      if (deal.status !== 'settled' || deal.partnerId === null) continue;
      if (!targetPartnerIds.has(deal.partnerId)) continue;
      const inRangePayments = deal.payments.filter((payment) =>
        isWithinSettlementDateRange(payment.date, range)
      );
      if (inRangePayments.length === 0) continue;

      const earliestDate = inRangePayments.reduce(
        (earliest, payment) => (payment.date < earliest ? payment.date : earliest),
        inRangePayments[0].date
      );

      candidates.push({
        freeePeriod: doc.period,
        dealId: deal.dealId,
        paymentDate: earliestDate,
        amount: inRangePayments.reduce((sum, payment) => sum + payment.amount, 0),
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.paymentDate !== b.paymentDate) return a.paymentDate.localeCompare(b.paymentDate);
    if (a.freeePeriod !== b.freeePeriod) return a.freeePeriod.localeCompare(b.freeePeriod);
    return a.dealId - b.dealId;
  });
}

export function buildReconciliationEntries(
  closedChannels: readonly ChannelCloseDoc[],
  closeKeyByPartnerId: ReadonlyMap<number, string>
): ReconciliationEntry[] {
  const partnerIdsByCloseKey = new Map<string, number[]>();
  for (const [partnerId, closeKey] of closeKeyByPartnerId) {
    const current = partnerIdsByCloseKey.get(closeKey);
    if (current === undefined) partnerIdsByCloseKey.set(closeKey, [partnerId]);
    else current.push(partnerId);
  }

  return closedChannels.map((channel) => ({
    closeKey: channel.channel,
    displayName: channel.displayName,
    appNet: resolveClosedChannelNet(channel),
    freeePartnerIds: [...(partnerIdsByCloseKey.get(channel.channel) ?? [])].sort((a, b) => a - b),
    matchedPayments: [],
  }));
}

function addMonthsToPeriod(period: string, months: number): string {
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1 + months;
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function lastDayOfPeriod(period: string): number {
  const [yearText, monthText] = period.split('-');
  // Date.UTC は month が 0-based。1-based の monthText をそのまま渡すと
  // 「翌月の0日目」= 当月末日になる。ローカルタイムの new Date は使わない。
  return new Date(Date.UTC(Number(yearText), Number(monthText), 0)).getUTCDate();
}

function resolveBoundDate(targetPeriod: string, bound: SettlementCycleBound): string {
  const period = addMonthsToPeriod(targetPeriod, bound.offsetMonths);
  const lastDay = lastDayOfPeriod(period);
  if (
    bound.day !== 'end' &&
    (!Number.isInteger(bound.day) || bound.day < 1 || bound.day > lastDay)
  ) {
    throw new Error(
      `入金サイクルの日付指定が不正です: period=${period} day=${String(
        bound.day
      )} (1〜${lastDay} または 'end')`
    );
  }
  const day = bound.day === 'end' ? lastDay : bound.day;
  return `${period}-${String(day).padStart(2, '0')}`;
}

export function resolveSettlementCycle(closeKey: string): SettlementCycle {
  return SETTLEMENT_CYCLE_BY_CLOSE_KEY[closeKey] ?? SETTLEMENT_DEFAULT_CYCLE;
}

export function settlementCandidateDateRange(
  targetPeriod: string,
  closeKey: string
): SettlementDateRange {
  const cycle = resolveSettlementCycle(closeKey);
  const startDate = resolveBoundDate(targetPeriod, cycle.start);
  const endDate = resolveBoundDate(targetPeriod, cycle.end);
  if (startDate > endDate) {
    throw new Error(`入金サイクルの範囲が逆転しています: ${startDate} 〜 ${endDate}`);
  }
  return { startDate, endDate };
}

export function isWithinSettlementDateRange(
  paymentDate: string,
  range: SettlementDateRange
): boolean {
  return paymentDate >= range.startDate && paymentDate <= range.endDate;
}

function formatRangeMonthDay(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function formatRangeYearMonthDay(date: string): string {
  const [year, month, day] = date.split('-');
  return `${year}/${Number(month)}/${Number(day)}`;
}

export function formatSettlementRangeLabel(range: SettlementDateRange): string {
  const crossesYear = range.startDate.slice(0, 4) !== range.endDate.slice(0, 4);
  return crossesYear
    ? `${formatRangeYearMonthDay(range.startDate)}〜${formatRangeYearMonthDay(range.endDate)}`
    : `${formatRangeMonthDay(range.startDate)}〜${formatRangeMonthDay(range.endDate)}`;
}

/**
 * 「freee の月次 doc が届いているか」を判定するために必要な月の一覧。
 *
 * ⚠️ これはヒューリスティックである。freee_income_deals/{period} の period は
 * 発生日(issue_date)の月であり、入金日の月とは一致しない。入金日が範囲内でも
 * 発生日が範囲外の月の deal はありうる。候補の生成は全 doc を走査して入金日で
 * 絞るので取り落としは起きないが、「取込が完了したか」は厳密には判定できない。
 * ここでは「範囲がまたぐ月の doc が届いていれば取込済みとみなす」という近似を採る。
 */
export function settlementImportRequiredPeriods(
  targetPeriod: string,
  closeKey: string
): readonly string[] {
  const range = settlementCandidateDateRange(targetPeriod, closeKey);
  const startPeriod = range.startDate.slice(0, 7);
  const endPeriod = range.endDate.slice(0, 7);
  const periods: string[] = [startPeriod];
  let cursor = startPeriod;
  while (cursor < endPeriod) {
    cursor = addMonthsToPeriod(cursor, 1);
    periods.push(cursor);
  }
  return periods;
}

/** @deprecated 候補の絞り込みには使わない。取込済み判定は settlementImportRequiredPeriods を使う */
export function isSettlementCandidatePeriod(
  targetPeriod: string,
  docPeriod: string,
  closeKey: string
): boolean {
  return settlementImportRequiredPeriods(targetPeriod, closeKey).includes(docPeriod);
}

function paymentKey(payment: MatchedPayment): string {
  return `${payment.freeePeriod}:${payment.dealId}`;
}

function sumPayments(payments: readonly MatchedPayment[]): number {
  return payments.reduce((sum, payment) => sum + payment.amount, 0);
}

function isAmountMatched(appNet: number, matchedTotal: number): boolean {
  const diff = Math.abs(appNet - matchedTotal);
  return diff <= Math.abs(appNet) * AUTO_MATCH_RATE && diff <= AUTO_MATCH_ABS;
}

function buildResult(
  entry: ReconciliationEntry,
  candidates: readonly MatchedPayment[],
  matchedPayments: readonly MatchedPayment[],
  status: MatchResult['status'],
  reviewed: boolean
): MatchResult {
  const matchedTotal = sumPayments(matchedPayments);
  return {
    closeKey: entry.closeKey,
    displayName: entry.displayName,
    appNet: entry.appNet,
    matchedPayments,
    matchedTotal,
    diff: entry.appNet - matchedTotal,
    status,
    reviewed,
    candidates,
  };
}

export function autoMatch(
  entries: readonly ReconciliationEntry[],
  candidatesByCloseKey: Readonly<Record<string, readonly MatchedPayment[]>>,
  overridesByCloseKey: Readonly<Record<string, CloseOverride>>
): MatchResult[] {
  return entries.map((entry) => {
    // 恒久的な対象外は他のどの判定よりも先に返す。
    // 候補があっても紐づけない（誤った取引先の入金が入り込むのを防ぐ）。
    if (RECONCILIATION_EXCLUDED_CLOSE_KEY_SET.has(entry.closeKey)) {
      return buildResult(entry, [], [], 'excluded', false);
    }

    if (AMOUNT_MATCH_INCOMPARABLE_CLOSE_KEY_SET.has(entry.closeKey)) {
      return buildResult(entry, [], [], 'excluded', false);
    }

    // 対応する freee 取引先が 1 件も無いなら、候補を探しようがない。
    // これを 'waiting' にすると「入金されていない」と誤読させる。
    if (entry.freeePartnerIds.length === 0) {
      return buildResult(entry, [], [], 'unmapped', false);
    }

    const candidates = candidatesByCloseKey[entry.closeKey] ?? [];
    const override = overridesByCloseKey[entry.closeKey];
    const candidateKeys = new Set(candidates.map((payment) => paymentKey(payment)));
    const savedExcludedKeys = override?.excludedPaymentKeys ?? [];
    const savedAddedKeys = override?.addedPaymentKeys ?? [];
    // 保存済み override には候補窓の変更で「もう存在しない key」が残りうる。
    // 保存値は消さず、判定時に現候補と交差した有効キーだけを使う。
    const effectiveExcludedKeys = new Set(
      savedExcludedKeys.filter((key) => candidateKeys.has(key))
    );
    const effectiveAddedKeys = new Set(savedAddedKeys.filter((key) => candidateKeys.has(key)));
    // 1つでも候補外の保存キーがあれば、確認した時点の候補と今の候補が別物ということ。
    // 「確認済み」を維持すると ReconciliationPanel の未処理一覧から隠れてしまうので落とす。
    const hasStaleSelection =
      effectiveExcludedKeys.size !== new Set(savedExcludedKeys).size ||
      effectiveAddedKeys.size !== new Set(savedAddedKeys).size;
    const reviewed = (override?.confirmed ?? false) && !hasStaleSelection;
    const selectableCandidates = candidates.filter(
      (payment) => !effectiveExcludedKeys.has(paymentKey(payment))
    );
    const hasManualSelection = effectiveExcludedKeys.size > 0 || effectiveAddedKeys.size > 0;

    if (candidates.length === 0) {
      return buildResult(entry, candidates, [], 'waiting', reviewed);
    }

    if (hasManualSelection) {
      const manuallyMatched =
        effectiveAddedKeys.size > 0
          ? selectableCandidates.filter((payment) => effectiveAddedKeys.has(paymentKey(payment)))
          : selectableCandidates;
      return buildResult(
        entry,
        candidates,
        manuallyMatched,
        isAmountMatched(entry.appNet, sumPayments(manuallyMatched)) ? 'manual' : 'needs_review',
        reviewed
      );
    }

    if (AUTO_MATCH_EXCLUDED_CLOSE_KEY_SET.has(entry.closeKey)) {
      return buildResult(entry, candidates, [], 'needs_review', reviewed);
    }

    if (isAmountMatched(entry.appNet, sumPayments(selectableCandidates))) {
      return buildResult(entry, candidates, selectableCandidates, 'auto', reviewed);
    }

    const nearCandidates = selectableCandidates.filter((payment) =>
      isAmountMatched(entry.appNet, payment.amount)
    );
    if (nearCandidates.length === 1) {
      return buildResult(entry, candidates, nearCandidates, 'auto', reviewed);
    }

    return buildResult(entry, candidates, [], 'needs_review', reviewed);
  });
}

export function summarizeMatchResults(results: readonly MatchResult[]): {
  readonly total: number;
  readonly auto: number;
  readonly manual: number;
  readonly needsReview: number;
  readonly waiting: number;
  readonly unmapped: number;
  readonly excluded: number;
  readonly unreviewed: number;
} {
  return results.reduce(
    (summary, result) => ({
      total: summary.total + 1,
      auto: summary.auto + (result.status === 'auto' ? 1 : 0),
      manual: summary.manual + (result.status === 'manual' ? 1 : 0),
      needsReview: summary.needsReview + (result.status === 'needs_review' ? 1 : 0),
      waiting: summary.waiting + (result.status === 'waiting' ? 1 : 0),
      unmapped: summary.unmapped + (result.status === 'unmapped' ? 1 : 0),
      excluded: summary.excluded + (result.status === 'excluded' ? 1 : 0),
      unreviewed:
        summary.unreviewed + (result.status === 'needs_review' && !result.reviewed ? 1 : 0),
    }),
    {
      total: 0,
      auto: 0,
      manual: 0,
      needsReview: 0,
      waiting: 0,
      unmapped: 0,
      excluded: 0,
      unreviewed: 0,
    }
  );
}

export function canConfirmPl(
  monthStatus: Pick<MonthlyCloseStatus, 'status'> | null,
  plSummary: Pick<MonthlyPlSummary, 'cashRevenueTotal' | 'cashExpenseTotal' | 'cashUsable'> | null
): boolean {
  return describeConfirmBlockers(monthStatus, plSummary).length === 0;
}

/**
 * 確定額(cashRevenueTotal/cashExpenseTotal)は monthly_pl_summary(freeeの実額)から取るため、
 * 入金突合(MatchResult)の未対応・要確認が残っていても凍結される金額は嘘にならない
 * (2026-08-23 オーナー判断: freee側の金額を信用し、突合の二重チェックはしない仕様に変更。
 *  旧仕様は unmapped/needs_review を確定前に必ず解消させていたが、確定額そのものには
 *  影響しないことが確認できたため撤去した)。
 */
export function describeConfirmBlockers(
  monthStatus: Pick<MonthlyCloseStatus, 'status'> | null,
  plSummary: Pick<MonthlyPlSummary, 'cashRevenueTotal' | 'cashExpenseTotal' | 'cashUsable'> | null
): string[] {
  const blockers: string[] = [];

  if (monthStatus?.status !== 'confirmed') {
    blockers.push('すべての販路が締め済みになっていません');
  }

  if (
    plSummary === null ||
    plSummary.cashRevenueTotal === null ||
    plSummary.cashExpenseTotal === null ||
    !plSummary.cashUsable
  ) {
    blockers.push('freeeの確定金額がまだ揃っていません（経理の入力待ち、または夜間バッチ未反映）');
  }

  return blockers;
}
