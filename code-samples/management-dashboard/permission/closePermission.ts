/**
 * 月次締めを実行できる人。
 *
 * ⚠️ この値は `経営ダッシュボード/firestore.rules` の `isCloser()` と**必ず一致させる**こと。
 * 画面側の判定はボタンを出すかどうかだけで、実際の防御は Firestore ルールが行う。
 */
export const CLOSER_EMAILS = ['owner@example.com', 'manager@example.com'] as const;

export function canCloseMonth(email: string | null | undefined): boolean {
  return CLOSER_EMAILS.some((closerEmail: string): boolean => email === closerEmail);
}
