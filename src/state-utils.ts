/** Unicode/case/whitespace-insensitive comparison for scene location labels. */
export function samePlace(a: string | undefined, b: string | undefined): boolean {
	if (!a?.trim() || !b?.trim()) return false;
	return a.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ===
		b.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}
