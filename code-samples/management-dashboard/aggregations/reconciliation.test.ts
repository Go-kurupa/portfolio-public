import { describe, expect, it } from 'vitest';
import type { Timestamp } from 'firebase/firestore';

import {
  RECONCILIATION_EXCLUDED_CLOSE_KEYS,
  autoMatch,
  buildMatchedPaymentCandidates,
  buildReconciliationEntries,
  canConfirmPl,
  describeConfirmBlockers,
  isWithinSettlementDateRange,
  isSettlementCandidatePeriod,
  resolvePlDisplay,
  settlementCandidateDateRange,
  settlementImportRequiredPeriods,
  summarizeMatchResults,
  summarizeSettlements,
} from './reconciliation';
import type { FreeeIncomeDealsDoc, FreeePartnerLink } from '../freee/incomeTypes';
import type {
  ChannelCloseDoc,
  CloseOverride,
  MatchedPayment,
  ReconciliationEntry,
} from '../types/facts';

describe('summarizeSettlements', () => {
  it('closeKey ごとに settled deal の payments 合計・最終入金日・deal 件数を集計する', () => {
    const docs = [
      {
        period: '2026-06',
        importedAt: {},
        importAudit: {
          pages: 1,
          dealCount: 3,
          detailCount: 3,
          dupDealIds: 0,
          manualJournalPages: 1,
          manualJournalCount: 0,
          manualJournalRevenueDetailCount: 0,
          manualJournalTotalCount: 0,
          manualJournalPagingStopReason: 'total_count_reached',
        },
        classificationStatus: 'complete',
        unclassifiedAmount: 0,
        invariantCheck: {
          glRevenueNetTotal: 0,
          salesCreditGrossTotal: 0,
          salesDebitGrossTotal: 0,
          salesTaxNetTotal: 0,
          importedSalesNetTotal: 0,
          diff: 0,
        },
        deals: [
          {
            dealId: 1,
            issueDate: '2026-06-03',
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [
              { date: '2026-06-03', amount: 67168 },
              { date: '2026-06-05', amount: 1000 },
            ],
          },
          {
            dealId: 2,
            issueDate: '2026-06-20',
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            status: 'unsettled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-20', amount: 999999 }],
          },
          {
            dealId: 3,
            issueDate: '2026-06-12',
            partnerId: 910002,
            partnerName: '販売先A',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-12', amount: 32000 }],
          },
        ],
      },
      {
        period: '2026-07',
        importedAt: {},
        importAudit: {
          pages: 1,
          dealCount: 1,
          detailCount: 1,
          dupDealIds: 0,
          manualJournalPages: 1,
          manualJournalCount: 0,
          manualJournalRevenueDetailCount: 0,
          manualJournalTotalCount: 0,
          manualJournalPagingStopReason: 'total_count_reached',
        },
        classificationStatus: 'complete',
        unclassifiedAmount: 0,
        invariantCheck: {
          glRevenueNetTotal: 0,
          salesCreditGrossTotal: 0,
          salesDebitGrossTotal: 0,
          salesTaxNetTotal: 0,
          importedSalesNetTotal: 0,
          diff: 0,
        },
        deals: [
          {
            dealId: 4,
            issueDate: '2026-07-08',
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-07-08', amount: 70000 }],
          },
        ],
      },
    ];

    const closeKeyByPartnerId = new Map([
      [910001, 'samplePartyA'],
      [910002, 'wakuwaku'],
    ]);

    expect(
      summarizeSettlements(docs, closeKeyByPartnerId, {
        samplePartyA: { startDate: '2026-06-01', endDate: '2026-07-31' },
        wakuwaku: { startDate: '2026-06-01', endDate: '2026-07-31' },
      })
    ).toEqual({
      samplePartyA: {
        settledPaymentsTotal: 138168,
        lastPaymentDate: '2026-07-08',
        dealCount: 2,
        partnerBreakdown: [
          {
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            total: 138168,
            lastPaymentDate: '2026-07-08',
            dealCount: 2,
          },
        ],
      },
      wakuwaku: {
        settledPaymentsTotal: 32000,
        lastPaymentDate: '2026-06-12',
        dealCount: 1,
        partnerBreakdown: [
          {
            partnerId: 910002,
            partnerName: '販売先A',
            total: 32000,
            lastPaymentDate: '2026-06-12',
            dealCount: 1,
          },
        ],
      },
    });
  });

  it('取引先(partnerId)単位の内訳を入金合計降順で返す', () => {
    const docs = [
      {
        period: '2026-06',
        importedAt: {},
        importAudit: {
          pages: 1,
          dealCount: 3,
          detailCount: 3,
          dupDealIds: 0,
          manualJournalPages: 1,
          manualJournalCount: 0,
          manualJournalRevenueDetailCount: 0,
          manualJournalTotalCount: 0,
          manualJournalPagingStopReason: 'total_count_reached',
        },
        classificationStatus: 'complete',
        unclassifiedAmount: 0,
        invariantCheck: {
          glRevenueNetTotal: 0,
          salesCreditGrossTotal: 0,
          salesDebitGrossTotal: 0,
          salesTaxNetTotal: 0,
          importedSalesNetTotal: 0,
          diff: 0,
        },
        deals: [
          {
            dealId: 1,
            issueDate: '2026-06-03',
            partnerId: 201,
            partnerName: '取引先A',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-03', amount: 5000 }],
          },
          {
            dealId: 2,
            issueDate: '2026-06-05',
            partnerId: 202,
            partnerName: '取引先B',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-05', amount: 12000 }],
          },
          {
            dealId: 3,
            issueDate: '2026-06-10',
            partnerId: 201,
            partnerName: '取引先A',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-10', amount: 3000 }],
          },
        ],
      },
    ];
    const closeKeyByPartnerId = new Map([
      [201, 'wakuwaku'],
      [202, 'wakuwaku'],
    ]);

    const summaries = summarizeSettlements(docs, closeKeyByPartnerId, {
      wakuwaku: { startDate: '2026-06-01', endDate: '2026-06-30' },
    });

    expect(summaries.wakuwaku.partnerBreakdown).toEqual([
      {
        partnerId: 202,
        partnerName: '取引先B',
        total: 12000,
        lastPaymentDate: '2026-06-05',
        dealCount: 1,
      },
      {
        partnerId: 201,
        partnerName: '取引先A',
        total: 8000,
        lastPaymentDate: '2026-06-10',
        dealCount: 2,
      },
    ]);
  });

  it('closeKey 未設定の link と partnerId 未設定 deal は無視する', () => {
    const docs = [
      {
        period: '2026-06',
        importedAt: {},
        importAudit: {
          pages: 1,
          dealCount: 2,
          detailCount: 2,
          dupDealIds: 0,
          manualJournalPages: 1,
          manualJournalCount: 0,
          manualJournalRevenueDetailCount: 0,
          manualJournalTotalCount: 0,
          manualJournalPagingStopReason: 'total_count_reached',
        },
        classificationStatus: 'complete',
        unclassifiedAmount: 0,
        invariantCheck: {
          glRevenueNetTotal: 0,
          salesCreditGrossTotal: 0,
          salesDebitGrossTotal: 0,
          salesTaxNetTotal: 0,
          importedSalesNetTotal: 0,
          diff: 0,
        },
        deals: [
          {
            dealId: 1,
            issueDate: '2026-06-03',
            partnerId: 910003,
            partnerName: '販売先E',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-03', amount: 10000 }],
          },
          {
            dealId: 2,
            issueDate: '2026-06-04',
            partnerId: null,
            partnerName: '',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-04', amount: 20000 }],
          },
        ],
      },
    ];

    const closeKeyByPartnerId = new Map<number, string>();

    expect(
      summarizeSettlements(docs, closeKeyByPartnerId, {
        wakuwaku: { startDate: '2026-06-01', endDate: '2026-06-30' },
      })
    ).toEqual({});
  });
});

describe('buildMatchedPaymentCandidates', () => {
  it('全取込済み period の settled deal から候補入金を作る', () => {
    const docs = [
      {
        period: '2026-06',
        importedAt: {},
        importAudit: {
          pages: 1,
          dealCount: 2,
          detailCount: 0,
          dupDealIds: 0,
          manualJournalPages: 1,
          manualJournalCount: 0,
          manualJournalRevenueDetailCount: 0,
          manualJournalTotalCount: 0,
          manualJournalPagingStopReason: 'total_count_reached',
        },
        classificationStatus: 'complete',
        unclassifiedAmount: 0,
        invariantCheck: {
          glRevenueNetTotal: 0,
          salesCreditGrossTotal: 0,
          salesDebitGrossTotal: 0,
          salesTaxNetTotal: 0,
          importedSalesNetTotal: 0,
          diff: 0,
        },
        deals: [
          {
            dealId: 10,
            issueDate: '2026-06-03',
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [
              { date: '2026-06-03', amount: 67168 },
              { date: '2026-06-05', amount: 1000 },
            ],
          },
          {
            dealId: 11,
            issueDate: '2026-06-10',
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            status: 'unsettled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-06-10', amount: 999999 }],
          },
        ],
      },
      {
        period: '2026-07',
        importedAt: {},
        importAudit: {
          pages: 1,
          dealCount: 1,
          detailCount: 0,
          dupDealIds: 0,
          manualJournalPages: 1,
          manualJournalCount: 0,
          manualJournalRevenueDetailCount: 0,
          manualJournalTotalCount: 0,
          manualJournalPagingStopReason: 'total_count_reached',
        },
        classificationStatus: 'complete',
        unclassifiedAmount: 0,
        invariantCheck: {
          glRevenueNetTotal: 0,
          salesCreditGrossTotal: 0,
          salesDebitGrossTotal: 0,
          salesTaxNetTotal: 0,
          importedSalesNetTotal: 0,
          diff: 0,
        },
        deals: [
          {
            dealId: 12,
            issueDate: '2026-07-08',
            partnerId: 910001,
            partnerName: '販売先D（直売所）',
            status: 'settled',
            dueDate: null,
            dueAmount: null,
            details: [],
            payments: [{ date: '2026-07-08', amount: 70000 }],
          },
        ],
      },
    ];

    expect(
      buildMatchedPaymentCandidates(docs, [910001], {
        startDate: '2026-06-01',
        endDate: '2026-07-31',
      })
    ).toEqual([
      {
        freeePeriod: '2026-06',
        dealId: 10,
        paymentDate: '2026-06-03',
        amount: 68168,
      },
      {
        freeePeriod: '2026-07',
        dealId: 12,
        paymentDate: '2026-07-08',
        amount: 70000,
      },
    ]);
  });
});

const saisaiLink: FreeePartnerLink = {
  freeePartnerId: 910001,
  freeePartnerName: '販売先D（直売所）',
  classification: 'egg',
  clientId: 'client-saisai',
  clientNameSnapshot: '販売先D',
  closeKey: 'samplePartyA',
  active: true,
  createdAt: {} as Timestamp,
  updatedAt: {} as Timestamp,
};

function settledDeal(
  dealId: number,
  issueDate: string,
  payments: ReadonlyArray<{ readonly date: string; readonly amount: number }>
): FreeeIncomeDealsDoc['deals'][number] {
  return {
    dealId,
    issueDate,
    partnerId: 910001,
    partnerName: '販売先D（直売所）',
    status: 'settled' as const,
    dueDate: null,
    dueAmount: null,
    details: [],
    payments: [...payments],
  };
}

function dealsDoc(
  period: string,
  deals: readonly FreeeIncomeDealsDoc['deals'][number][]
): FreeeIncomeDealsDoc {
  return {
    period,
    importedAt: {} as Timestamp,
    importAudit: {
      pages: 1,
      dealCount: deals.length,
      detailCount: 0,
      dupDealIds: 0,
      manualJournalPages: 1,
      manualJournalCount: 0,
      manualJournalRevenueDetailCount: 0,
      manualJournalTotalCount: 0,
      manualJournalPagingStopReason: 'total_count_reached',
    },
    classificationStatus: 'complete' as const,
    unclassifiedAmount: 0,
    invariantCheck: {
      glRevenueNetTotal: 0,
      salesCreditGrossTotal: 0,
      salesDebitGrossTotal: 0,
      salesTaxNetTotal: 0,
      importedSalesNetTotal: 0,
      diff: 0,
    },
    deals,
  };
}

describe('入金日での絞り込み', () => {
  const saisaiRange = { startDate: '2026-05-16', endDate: '2026-06-15' } as const;

  const docs = [
    dealsDoc('2026-05', [
      settledDeal(101, '2026-05-08', [{ date: '2026-05-08', amount: 10355 }]),
      settledDeal(102, '2026-05-20', [{ date: '2026-05-20', amount: 62691 }]),
    ]),
    dealsDoc('2026-06', [
      settledDeal(103, '2026-06-03', [{ date: '2026-06-03', amount: 67168 }]),
      settledDeal(104, '2026-06-18', [{ date: '2026-06-18', amount: 32770 }]),
    ]),
  ];

  it('範囲外の入金(5/8・6/18)を候補から除き、5/20と6/3だけを残す', () => {
    const candidates = buildMatchedPaymentCandidates(docs, [910001], saisaiRange);
    expect(candidates.map((candidate) => candidate.paymentDate)).toEqual([
      '2026-05-20',
      '2026-06-03',
    ]);
    expect(candidates.reduce((sum, candidate) => sum + candidate.amount, 0)).toBe(129859);
  });

  it('発生日月と入金日月がズレる deal も取り落とさない(発生日5月・入金6月)', () => {
    const straddlingDocs = [
      dealsDoc('2026-05', [
        settledDeal(201, '2026-05-31', [{ date: '2026-06-03', amount: 50000 }]),
      ]),
    ];
    const candidates = buildMatchedPaymentCandidates(straddlingDocs, [910001], saisaiRange);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].freeePeriod).toBe('2026-05');
    expect(candidates[0].paymentDate).toBe('2026-06-03');
  });

  it('発生日が範囲内でも入金日が範囲外なら候補に入らない(発生日6月・入金7月)', () => {
    const lateDocs = [
      dealsDoc('2026-06', [
        settledDeal(202, '2026-06-10', [{ date: '2026-07-02', amount: 40000 }]),
      ]),
    ];
    expect(buildMatchedPaymentCandidates(lateDocs, [910001], saisaiRange)).toEqual([]);
  });

  it('1つのdealが範囲内外の入金を持つ場合は範囲内だけ合計する', () => {
    const straddling = [
      dealsDoc('2026-06', [
        settledDeal(203, '2026-06-03', [
          { date: '2026-06-03', amount: 67168 },
          { date: '2026-06-20', amount: 5000 },
        ]),
      ]),
    ];
    const candidates = buildMatchedPaymentCandidates(straddling, [910001], saisaiRange);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].amount).toBe(67168);
    expect(candidates[0].paymentDate).toBe('2026-06-03');
  });

  it('summarizeSettlements も範囲内の入金だけを合計する', () => {
    const summaries = summarizeSettlements(
      docs,
      new Map([[saisaiLink.freeePartnerId, saisaiLink.closeKey as string]]),
      { samplePartyA: saisaiRange }
    );
    expect(summaries.samplePartyA.settledPaymentsTotal).toBe(129859);
    expect(summaries.samplePartyA.lastPaymentDate).toBe('2026-06-03');
  });
});

describe('buildReconciliationEntries', () => {
  it('締め済み channel doc だけを台帳エントリ化し、matchedPayments は空で初期化する', () => {
    const closedChannels = [
      {
        schemaVersion: 2,
        period: '2026-06',
        channel: 'samplePartyA',
        snapshotGross: 74440,
        snapshotNet: 66997,
        snapshotQuantity: 720,
        snapshotDocCount: 2,
        snapshotHash: 'hash-saisai',
        closedAt: {},
        closedBy: 'closer@example.com',
        displayName: '委託 販売先D（2 店舗）',
        memberPartnerKeys: ['wmP1yhZ2cv28JwpSKRbq', 'AuPAwEzi8JshAVKD7fPx'],
      },
      {
        schemaVersion: 2,
        period: '2026-06',
        channel: 'wakuwaku',
        snapshotGross: 40000,
        snapshotNet: 36000,
        snapshotQuantity: 300,
        snapshotDocCount: 1,
        snapshotHash: 'hash-waku',
        closedAt: {},
        closedBy: 'closer@example.com',
        displayName: '販売先A',
        memberPartnerKeys: ['wakuwaku'],
      },
    ];
    // 999999(停止済みリンク) は resolvePartnerCloseKeys の段階で既に除外されている前提のため、
    // ここでは解決済み Map に含めない。
    const resolved = new Map([
      [910001, 'samplePartyA'],
      [104076002, 'samplePartyA'],
    ]);

    expect(buildReconciliationEntries(closedChannels, resolved)).toEqual([
      {
        closeKey: 'samplePartyA',
        displayName: '委託 販売先D（2 店舗）',
        appNet: 66997,
        freeePartnerIds: [910001, 104076002],
        matchedPayments: [],
      },
      {
        closeKey: 'wakuwaku',
        displayName: '販売先A',
        appNet: 36000,
        freeePartnerIds: [],
        matchedPayments: [],
      },
    ]);
  });

  it('委託は月次締めが採用した confirmedNet と入金候補が一致すれば auto になる', () => {
    const closedChannels: readonly ChannelCloseDoc[] = [
      {
        schemaVersion: 4,
        period: '2026-06',
        channel: 'samplePartyB',
        snapshotGross: 43314,
        snapshotNet: 38983,
        snapshotQuantity: 400,
        snapshotDocCount: 1,
        snapshotHash: 'hash-hirafuku',
        closedAt: {} as Timestamp,
        closedBy: 'closer@example.com',
        displayName: '販売先B',
        memberPartnerKeys: ['hirafuku'],
        confirmedNet: 38576,
      },
    ];
    const entries = buildReconciliationEntries(
      closedChannels,
      new Map([[101, 'samplePartyB']])
    );
    const candidates: readonly MatchedPayment[] = [
      {
        freeePeriod: '2026-07',
        dealId: 1,
        paymentDate: '2026-07-10',
        amount: 38576,
      },
    ];

    const [result] = autoMatch(entries, { samplePartyB: candidates }, {});

    expect(result.appNet).toBe(38576);
    expect(result.diff).toBe(0);
    expect(result.status).toBe('auto');
  });

  it('買い切りは confirmedNet があっても snapshotNet 基準の額を保ち、突合は excluded にする', () => {
    const closedChannels: readonly ChannelCloseDoc[] = [
      {
        schemaVersion: 4,
        period: '2026-06',
        channel: 'kaikiri',
        snapshotGross: 40000,
        snapshotNet: 36000,
        snapshotQuantity: 300,
        snapshotDocCount: 1,
        snapshotHash: 'hash-kaikiri',
        closedAt: {} as Timestamp,
        closedBy: 'closer@example.com',
        displayName: '買い切り',
        memberPartnerKeys: ['kaikiri'],
        confirmedNet: 33000,
      },
    ];
    const entries = buildReconciliationEntries(closedChannels, new Map([[102, 'kaikiri']]));
    const candidates: readonly MatchedPayment[] = [
      {
        freeePeriod: '2026-07',
        dealId: 2,
        paymentDate: '2026-07-10',
        amount: 36000,
      },
    ];

    const [result] = autoMatch(entries, { kaikiri: candidates }, {});

    expect(result.appNet).toBe(36000);
    expect(result.diff).toBe(36000);
    expect(result.status).toBe('excluded');
    expect(result.matchedPayments).toEqual([]);
    expect(result.candidates).toEqual([]);
  });
});

describe('settlementCandidateDateRange', () => {
  it('既定サイクルは翌月1日から翌月末日まで', () => {
    expect(settlementCandidateDateRange('2026-06', 'wakuwaku')).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });
  });

  it('既定サイクルの2月末は28日/29日を正しく出す', () => {
    expect(settlementCandidateDateRange('2026-01', 'wakuwaku')).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(settlementCandidateDateRange('2028-01', 'wakuwaku')).toEqual({
      startDate: '2028-02-01',
      endDate: '2028-02-29',
    });
  });

  it('販売先Dは対象月16日から翌月15日まで（半月境界）', () => {
    expect(settlementCandidateDateRange('2026-05', 'samplePartyA')).toEqual({
      startDate: '2026-05-16',
      endDate: '2026-06-15',
    });
  });

  it('販売先Dは年をまたいでも正しい', () => {
    expect(settlementCandidateDateRange('2026-12', 'samplePartyA')).toEqual({
      startDate: '2026-12-16',
      endDate: '2027-01-15',
    });
  });
});

describe('isWithinSettlementDateRange', () => {
  const range = { startDate: '2026-05-16', endDate: '2026-06-15' } as const;

  it('両端は含む', () => {
    expect(isWithinSettlementDateRange('2026-05-16', range)).toBe(true);
    expect(isWithinSettlementDateRange('2026-06-15', range)).toBe(true);
  });

  it('範囲外は含まない', () => {
    expect(isWithinSettlementDateRange('2026-05-15', range)).toBe(false);
    expect(isWithinSettlementDateRange('2026-06-16', range)).toBe(false);
  });
});

describe('settlementImportRequiredPeriods', () => {
  it('既定サイクルは翌月1ヶ月だけ', () => {
    expect(settlementImportRequiredPeriods('2026-06', 'wakuwaku')).toEqual(['2026-07']);
  });

  it('販売先Dは対象月と翌月の2ヶ月', () => {
    expect(settlementImportRequiredPeriods('2026-05', 'samplePartyA')).toEqual([
      '2026-05',
      '2026-06',
    ]);
  });

  it('年をまたぐ範囲も月を列挙できる', () => {
    expect(settlementImportRequiredPeriods('2026-12', 'samplePartyA')).toEqual([
      '2026-12',
      '2027-01',
    ]);
  });
});

describe('autoMatch', () => {
  const entry = (overrides: Partial<ReconciliationEntry> = {}): ReconciliationEntry => ({
    closeKey: 'wakuwaku',
    displayName: '販売先A',
    appNet: 100000,
    freeePartnerIds: [910002],
    matchedPayments: [],
    ...overrides,
  });
  const payment = (dealId: number, amount: number, freeePeriod = '2026-07'): MatchedPayment => ({
    freeePeriod,
    dealId,
    paymentDate: `${freeePeriod}-10`,
    amount,
  });
  const key = (p: MatchedPayment): string => `${p.freeePeriod}:${p.dealId}`;
  const ts = {} as Timestamp;
  const override = (patch: Partial<CloseOverride>): CloseOverride => ({
    excludedPaymentKeys: [],
    addedPaymentKeys: [],
    note: '',
    confirmed: false,
    updatedAt: ts,
    updatedBy: 'owner@example.com',
    ...patch,
  });

  it('候補全部の合計が許容誤差以内なら auto で全件を対応付ける', () => {
    const payments = [payment(1, 60000), payment(2, 39000)];

    const [result] = autoMatch([entry()], { wakuwaku: payments }, {});

    expect(result.status).toBe('auto');
    expect(result.matchedPayments).toEqual(payments);
    expect(result.matchedTotal).toBe(99000);
    expect(result.diff).toBe(1000);
  });

  it('合計は合わないが許容誤差以内の候補が1件だけならその1件を auto で対応付ける', () => {
    const near = payment(1, 99000);
    const far = payment(2, 50000);

    const [result] = autoMatch([entry()], { wakuwaku: [near, far] }, {});

    expect(result.status).toBe('auto');
    expect(result.matchedPayments).toEqual([near]);
    expect(result.matchedTotal).toBe(99000);
  });

  it('許容誤差以内の候補が2件以上あると needs_review にして自動対応付けしない', () => {
    const payments = [payment(1, 99000), payment(2, 100500)];

    const [result] = autoMatch([entry()], { wakuwaku: payments }, {});

    expect(result.status).toBe('needs_review');
    expect(result.matchedPayments).toEqual([]);
    expect(result.candidates).toEqual(payments);
  });

  // 2026-08-20 に許容誤差を 1%/¥1,000 → 3%/¥3,000 へ緩和した際の境界。
  // 委託先の手数料端数・半月境界の日ずれ（販売先Dで実測 2.3%）を自動一致させつつ、
  // 1万円単位の欠損は従来どおり needs_review で止めることを固定する。
  it('差が許容誤差ちょうど(3%かつ¥3,000)なら auto にする', () => {
    // appNet=100,000 に対し合計 103,000（差 ¥3,000 = 3.0%）
    const payments = [payment(1, 60000), payment(2, 43000)];

    const [result] = autoMatch([entry()], { wakuwaku: payments }, {});

    expect(result.status).toBe('auto');
    expect(result.matchedTotal).toBe(103000);
  });

  it('差が許容誤差を1円でも超えたら needs_review にする', () => {
    // appNet=100,000 に対し合計 103,001（差 ¥3,001）
    const payments = [payment(1, 60000), payment(2, 43001)];

    const [result] = autoMatch([entry()], { wakuwaku: payments }, {});

    expect(result.status).toBe('needs_review');
    expect(result.matchedPayments).toEqual([]);
  });

  it('売上が大きくても差の上限は¥3,000で止まる（率だけでは通さない）', () => {
    // appNet=1,000,000 の 3% は ¥30,000 だが、絶対額の上限 ¥3,000 を超えるので needs_review
    const payments = [payment(1, 1005000)];

    const [result] = autoMatch([entry({ appNet: 1000000 })], { wakuwaku: payments }, {});

    expect(result.status).toBe('needs_review');
  });

  it('候補ゼロなら waiting にする', () => {
    const [result] = autoMatch([entry()], {}, {});

    expect(result.status).toBe('waiting');
    expect(result.matchedPayments).toEqual([]);
    expect(result.matchedTotal).toBe(0);
  });

  it('除外を適用して合わなくなれば needs_review にする', () => {
    const keep = payment(1, 60000);
    const excluded = payment(2, 40000);

    const [result] = autoMatch(
      [entry()],
      { wakuwaku: [keep, excluded] },
      { wakuwaku: override({ excludedPaymentKeys: [key(excluded)] }) }
    );

    expect(result.status).toBe('needs_review');
    expect(result.matchedPayments).toEqual([keep]);
    expect(result.matchedTotal).toBe(60000);
  });

  it('追加した入金で合えば manual にする', () => {
    const addedA = payment(1, 70000);
    const addedB = payment(2, 30000);
    const ignored = payment(3, 5000);

    const [result] = autoMatch(
      [entry()],
      { wakuwaku: [addedA, addedB, ignored] },
      { wakuwaku: override({ addedPaymentKeys: [key(addedA), key(addedB)] }) }
    );

    expect(result.status).toBe('manual');
    expect(result.matchedPayments).toEqual([addedA, addedB]);
    expect(result.matchedTotal).toBe(100000);
  });

  it('samplePartyA は金額が一致すれば自動突合する（2026-08-20〜 突合対象化）', () => {
    const payments = [payment(1, 100000)];

    const [result] = autoMatch(
      [entry({ closeKey: 'samplePartyA', displayName: '販売先D' })],
      { samplePartyA: payments },
      {}
    );

    expect(result.status).toBe('auto');
    expect(result.matchedPayments).toEqual(payments);
    expect(result.candidates).toEqual(payments);
  });

  describe('候補外になった手動指定の扱い', () => {
    const candidatePayment = (dealId: number, amount: number): MatchedPayment => ({
      freeePeriod: '2026-06',
      dealId,
      paymentDate: '2026-06-03',
      amount,
    });

    it('保存済みの除外キーが現候補に存在しないなら手動指定として扱わない', () => {
      const payment301 = candidatePayment(301, 100000);
      const results = autoMatch(
        [entry({ closeKey: 'samplePartyA', appNet: 100000 })],
        { samplePartyA: [payment301] },
        { samplePartyA: override({ excludedPaymentKeys: ['2026-05:999'] }) }
      );
      // 除外キーが手動指定として扱われないため、通常の金額突合が働き auto になる。
      expect(results[0].status).toBe('auto');
      expect(results[0].matchedPayments).toEqual([payment301]);
    });

    it('保存済みの追加キーが現候補に存在しないなら手動指定として扱わない', () => {
      const results = autoMatch(
        [entry({ closeKey: 'wakuwaku', appNet: 100000 })],
        { wakuwaku: [candidatePayment(302, 100000)] },
        { wakuwaku: override({ addedPaymentKeys: ['2026-05:998'] }) }
      );
      expect(results[0].status).toBe('auto');
      expect(results[0].matchedTotal).toBe(100000);
    });

    it('現候補に存在する除外キーは今まで通り効く', () => {
      const results = autoMatch(
        [entry({ closeKey: 'wakuwaku', appNet: 100000 })],
        { wakuwaku: [candidatePayment(303, 100000), candidatePayment(304, 50000)] },
        { wakuwaku: override({ excludedPaymentKeys: ['2026-06:304'] }) }
      );
      expect(results[0].matchedPayments.map((matched) => matched.dealId)).toEqual([303]);
      expect(results[0].status).toBe('manual');
    });

    it('候補外キーが残っている確認済みは reviewed を false に落とす（再確認を促す）', () => {
      const results = autoMatch(
        [entry({ closeKey: 'samplePartyA', appNet: 100000 })],
        { samplePartyA: [candidatePayment(305, 100000)] },
        {
          samplePartyA: override({
            excludedPaymentKeys: ['2026-05:999'],
            confirmed: true,
          }),
        }
      );
      // 金額は一致するので auto になるが、候補が変わったことは reviewed=false で示す。
      expect(results[0].status).toBe('auto');
      expect(results[0].reviewed).toBe(false);
    });

    it('保存済みキーがすべて現候補にあるなら確認済みは維持する', () => {
      const results = autoMatch(
        [entry({ closeKey: 'samplePartyA', appNet: 100000 })],
        { samplePartyA: [candidatePayment(306, 100000), candidatePayment(307, 50000)] },
        {
          samplePartyA: override({
            excludedPaymentKeys: ['2026-06:307'],
            confirmed: true,
          }),
        }
      );
      expect(results[0].reviewed).toBe(true);
    });

    it('override が無い場合の挙動は変わらない', () => {
      const results = autoMatch(
        [entry({ closeKey: 'wakuwaku', appNet: 100000 })],
        { wakuwaku: [candidatePayment(308, 100000)] },
        {}
      );
      expect(results[0].status).toBe('auto');
      expect(results[0].reviewed).toBe(false);
    });
  });

  it('既定サイクルは対象月の翌月だけを候補にする', () => {
    expect(settlementImportRequiredPeriods('2026-06', 'wakuwaku')).toEqual(['2026-07']);
    expect(isSettlementCandidatePeriod('2026-06', '2026-06', 'wakuwaku')).toBe(false);
    expect(isSettlementCandidatePeriod('2026-06', '2026-07', 'wakuwaku')).toBe(true);
    expect(isSettlementCandidatePeriod('2026-06', '2026-08', 'wakuwaku')).toBe(false);
  });

  it('samplePartyA は対象月と翌月を候補にする', () => {
    expect(settlementImportRequiredPeriods('2026-06', 'samplePartyA')).toEqual([
      '2026-06',
      '2026-07',
    ]);
    expect(isSettlementCandidatePeriod('2026-06', '2026-05', 'samplePartyA')).toBe(false);
    expect(isSettlementCandidatePeriod('2026-06', '2026-06', 'samplePartyA')).toBe(true);
    expect(isSettlementCandidatePeriod('2026-06', '2026-07', 'samplePartyA')).toBe(true);
    expect(isSettlementCandidatePeriod('2026-06', '2026-08', 'samplePartyA')).toBe(false);
  });

  it('reviewed=true の needs_review は summarize の unreviewed に数えない', () => {
    const reviewed = autoMatch(
      [entry({ closeKey: 'reviewed' })],
      { reviewed: [payment(1, 40000)] },
      { reviewed: override({ confirmed: true }) }
    );
    const unreviewed = autoMatch(
      [entry({ closeKey: 'unreviewed' })],
      { unreviewed: [payment(2, 40000)] },
      {}
    );

    expect(summarizeMatchResults([...reviewed, ...unreviewed])).toEqual({
      total: 2,
      auto: 0,
      manual: 0,
      needsReview: 2,
      waiting: 0,
      unmapped: 0,
      excluded: 0,
      unreviewed: 1,
    });
  });
});

describe('canConfirmPl', () => {
  const confirmedMonth = { status: 'confirmed' as const };
  const usablePl = {
    cashRevenueTotal: 1713392,
    cashExpenseTotal: 943210,
    cashUsable: true,
  };

  it('月締め済み・cash PL 利用可なら true', () => {
    expect(canConfirmPl(confirmedMonth, usablePl)).toBe(true);
  });

  it('売上締めが未確定なら false', () => {
    expect(canConfirmPl({ status: 'open' }, usablePl)).toBe(false);
  });

  it('cash PL が未完成なら false', () => {
    expect(
      canConfirmPl(confirmedMonth, {
        cashRevenueTotal: null,
        cashExpenseTotal: 943210,
        cashUsable: true,
      })
    ).toBe(false);
    expect(
      canConfirmPl(confirmedMonth, {
        cashRevenueTotal: 1713392,
        cashExpenseTotal: null,
        cashUsable: true,
      })
    ).toBe(false);
    expect(
      canConfirmPl(confirmedMonth, {
        cashRevenueTotal: 1713392,
        cashExpenseTotal: 943210,
        cashUsable: false,
      })
    ).toBe(false);
  });
});

describe('describeConfirmBlockers', () => {
  const confirmedMonth = { status: 'confirmed' as const };
  const usablePl = {
    cashRevenueTotal: 1713392,
    cashExpenseTotal: 943210,
    cashUsable: true,
  };

  it('売上締めが未確定なら販路締め待ちの理由を返す', () => {
    expect(describeConfirmBlockers({ status: 'open' }, usablePl)).toEqual([
      'すべての販路が締め済みになっていません',
    ]);
  });

  it('freee の cash PL が未完成なら freee 確定金額待ちの理由を返す', () => {
    expect(describeConfirmBlockers(confirmedMonth, null)).toEqual([
      'freeeの確定金額がまだ揃っていません（経理の入力待ち、または夜間バッチ未反映）',
    ]);
    expect(
      describeConfirmBlockers(confirmedMonth, {
        cashRevenueTotal: null,
        cashExpenseTotal: 943210,
        cashUsable: true,
      })
    ).toEqual(['freeeの確定金額がまだ揃っていません（経理の入力待ち、または夜間バッチ未反映）']);
    expect(
      describeConfirmBlockers(confirmedMonth, {
        cashRevenueTotal: 1713392,
        cashExpenseTotal: null,
        cashUsable: true,
      })
    ).toEqual(['freeeの確定金額がまだ揃っていません（経理の入力待ち、または夜間バッチ未反映）']);
    expect(
      describeConfirmBlockers(confirmedMonth, {
        cashRevenueTotal: 1713392,
        cashExpenseTotal: 943210,
        cashUsable: false,
      })
    ).toEqual(['freeeの確定金額がまだ揃っていません（経理の入力待ち、または夜間バッチ未反映）']);
  });

  it('複数条件が欠けていれば不足理由をすべて返す', () => {
    expect(describeConfirmBlockers({ status: 'open' }, null)).toEqual([
      'すべての販路が締め済みになっていません',
      'freeeの確定金額がまだ揃っていません（経理の入力待ち、または夜間バッチ未反映）',
    ]);
  });

  it('すべて満たしていれば空配列を返す', () => {
    expect(describeConfirmBlockers(confirmedMonth, usablePl)).toEqual([]);
  });
});

describe('resolvePlDisplay', () => {
  const estimatedPl = {
    cashRevenueTotal: 1713392,
    cashExpenseTotal: 943210,
    profit: { value: 123456, basis: 'consumption' as const },
  };

  it('plConfirmedAt があり cash 売上・費用が揃う月だけ freee 実額差引利益を確定表示にする', () => {
    expect(resolvePlDisplay(estimatedPl, { plConfirmedAt: {} })).toEqual({
      profitValue: 770182,
      badge: 'confirmed',
      source: 'freee_cash',
    });
  });

  it('plConfirmedAt が無い月は従来の消費ベース profit を概算表示にする', () => {
    expect(resolvePlDisplay(estimatedPl, { plConfirmedAt: null })).toEqual({
      profitValue: 123456,
      badge: 'estimate',
      source: 'consumption',
    });
  });

  it('plConfirmedAt があっても cash 売上・費用のどちらかが欠けるなら概算表示に戻す', () => {
    expect(
      resolvePlDisplay(
        {
          cashRevenueTotal: null,
          cashExpenseTotal: 943210,
          profit: { value: -1000, basis: 'consumption' as const },
        },
        { plConfirmedAt: {} }
      )
    ).toEqual({
      profitValue: -1000,
      badge: 'estimate',
      source: 'consumption',
    });

    expect(
      resolvePlDisplay(
        {
          cashRevenueTotal: 1713392,
          cashExpenseTotal: null,
          profit: { value: null, basis: 'consumption' as const },
        },
        { plConfirmedAt: {} }
      )
    ).toEqual({
      profitValue: null,
      badge: 'estimate',
      source: 'consumption',
    });
  });

  it('plSummary が無いときは概算・値なしとして返す', () => {
    expect(resolvePlDisplay(null, { plConfirmedAt: {} })).toEqual({
      profitValue: null,
      badge: 'estimate',
      source: 'consumption',
    });
  });
});

describe('autoMatch — 未対応と突合対象外', () => {
  function entry(closeKey: string, appNet: number, freeePartnerIds: number[]) {
    return { closeKey, displayName: closeKey, appNet, freeePartnerIds, matchedPayments: [] };
  }

  it('買い切りは入金候補があっても excluded とし、候補を紐づけない', () => {
    const candidates = {
      kaikiri: [{ freeePeriod: '2026-06', dealId: 1, paymentDate: '2026-06-10', amount: 1124682 }],
    };
    const results = autoMatch([entry('kaikiri', 1022438, [1])], candidates, {});
    expect(results[0].status).toBe('excluded');
    expect(results[0].matchedPayments).toEqual([]);
    expect(results[0].candidates).toEqual([]);
    expect(results[0].matchedTotal).toBe(0);
  });

  it('対応表はあるが候補が無いなら waiting のまま', () => {
    const results = autoMatch([entry('wakuwaku', 121230, [910002])], {}, {});
    expect(results[0].status).toBe('waiting');
  });

  it('取引先Cは対応表未登録なら unmapped（2026-08-20〜 突合対象化、excluded ではない）', () => {
    const results = autoMatch([entry('tententen', 150560, [])], {}, {});
    expect(results[0].status).toBe('unmapped');
  });

  it('取引先Cは対応表があり金額が一致すれば自動突合する（2026-08-20〜 突合対象化）', () => {
    const candidates = {
      tententen: [{ freeePeriod: '2026-06', dealId: 1, paymentDate: '2026-06-10', amount: 150560 }],
    };
    const results = autoMatch([entry('tententen', 150560, [1])], candidates, {});
    expect(results[0].status).toBe('auto');
    expect(results[0].matchedTotal).toBe(150560);
  });

  it('販売先Dは候補窓が半月境界で絞られているため金額が一致すれば自動突合する（2026-08-20〜 突合対象化）', () => {
    const candidates = {
      samplePartyA: [
        { freeePeriod: '2026-06', dealId: 2, paymentDate: '2026-06-20', amount: 100000 },
      ],
    };
    const results = autoMatch([entry('samplePartyA', 100000, [2])], candidates, {});
    expect(results[0].status).toBe('auto');
    expect(results[0].matchedTotal).toBe(100000);
  });

  it('委託系は従来どおり金額が一致すれば自動突合する', () => {
    const candidates = {
      wakuwaku: [{ freeePeriod: '2026-07', dealId: 3, paymentDate: '2026-07-10', amount: 121230 }],
    };
    const results = autoMatch([entry('wakuwaku', 121230, [3])], candidates, {});
    expect(results[0].status).toBe('auto');
    expect(results[0].matchedPayments).toEqual(candidates.wakuwaku);
  });

  it('買い切りは販路対応ドロップダウンに必要なため対応表の対象外にしない', () => {
    // ここに含めると closeKeyOptions から消え、買い切りの確定額計算が壊れる。
    expect(RECONCILIATION_EXCLUDED_CLOSE_KEYS).not.toContain('kaikiri');
  });
});

describe('summarizeMatchResults — 新状態の件数', () => {
  it('unmapped と excluded を別々に数える', () => {
    const base = {
      displayName: '',
      appNet: 0,
      matchedPayments: [],
      matchedTotal: 0,
      diff: 0,
      reviewed: false,
      candidates: [],
    };
    const summary = summarizeMatchResults([
      { ...base, closeKey: 'a', status: 'unmapped' },
      { ...base, closeKey: 'b', status: 'unmapped' },
      { ...base, closeKey: 'c', status: 'excluded' },
      { ...base, closeKey: 'd', status: 'waiting' },
    ]);
    expect(summary.unmapped).toBe(2);
    expect(summary.excluded).toBe(1);
    expect(summary.waiting).toBe(1);
    expect(summary.total).toBe(4);
  });
});

describe('describeConfirmBlockers — 入金突合の未対応・要確認は確定を妨げない (2026-08-23〜)', () => {
  // 確定額(cashRevenueTotal/cashExpenseTotal)は monthly_pl_summary(freeeの実額)から採るため、
  // 販路ごとの入金突合(unmapped/needs_review)が残っていても凍結される金額は変わらない。
  // オーナー判断でこの二重チェックは確定の条件から外した(旧仕様はここで確定をブロックしていた)。
  it('締め済み・freee確定金額あり、の2条件だけで確定できる', () => {
    const blockers = describeConfirmBlockers(
      { status: 'confirmed' },
      { cashRevenueTotal: 100, cashExpenseTotal: 50, cashUsable: true }
    );
    expect(blockers).toEqual([]);
  });
});

describe('buildReconciliationEntries — 解決済み Map を受け取る', () => {
  it('締めキーごとに対応する freee 取引先 ID を昇順で並べる', () => {
    const closed = [{ channel: 'kaikiri', displayName: '買い切り', snapshotNet: 751026 } as never];
    const resolved = new Map([
      [3, 'kaikiri'],
      [1, 'kaikiri'],
      [2, 'wakuwaku'],
    ]);
    const entries = buildReconciliationEntries(closed, resolved);
    expect(entries).toHaveLength(1);
    expect(entries[0].freeePartnerIds).toEqual([1, 3]);
  });
});
