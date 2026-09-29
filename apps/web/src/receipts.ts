// Receipts saved on this device only. localStorage can be unavailable (private windows, blocked storage), so every access is guarded.
export type SavedReceipt = { pollId: string; title: string; receipt: string };
const KEY = "witness:receipts";

export function savedReceipts(): SavedReceipt[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedReceipt[];
  } catch {
    return [];
  }
}

export function saveReceipt(r: SavedReceipt) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...savedReceipts().filter((x) => x.receipt !== r.receipt), r]));
  } catch {
    /* not saved */
  }
}

export function forgetReceipts() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
