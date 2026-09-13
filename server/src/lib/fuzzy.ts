/**
 * Optimal string alignment distance (Damerau-Levenshtein restricted to
 * adjacent transpositions). Good enough for typo tolerance on search terms
 * and much cheaper than full Damerau.
 */
export function damerauLevenshtein(a: string, b: string, max = 4): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  if (Math.abs(a.length - b.length) > max) return max + 1

  const width = b.length + 1
  let prev2: number[] = []
  let prev: number[] = new Array(width)
  let curr: number[] = new Array(width)

  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = curr[0]!

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        curr[j - 1]! + 1, // insertion
        prev[j]! + 1, // deletion
        prev[j - 1]! + cost, // substitution
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2]! + 1) // transposition
      }
      curr[j] = value
      if (value < rowMin) rowMin = value
    }

    // Every remaining row can only increase the distance, so bail out early.
    if (rowMin > max) return max + 1

    prev2 = prev
    prev = curr
    curr = new Array(width)
  }

  return prev[b.length]!
}

/**
 * How much typo tolerance a term earns. Short terms get none, because at
 * three characters almost everything is within one edit of everything else.
 */
export function allowedEdits(term: string): number {
  if (term.length <= 3) return 0
  if (term.length <= 5) return 1
  return 2
}

/** Trigram set of a string, used for cheap similarity pre-filtering. */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value} `
  const out = new Set<string>()
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3))
  return out
}

/** Jaccard similarity of two trigram sets, in [0, 1]. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const setA = trigrams(a)
  const setB = trigrams(b)
  let shared = 0
  for (const gram of setA) if (setB.has(gram)) shared++
  const union = setA.size + setB.size - shared
  return union === 0 ? 0 : shared / union
}
