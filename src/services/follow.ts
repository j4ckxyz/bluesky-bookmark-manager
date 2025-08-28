// Follow feature disabled to comply with least-privilege scopes

export async function followCreator(_subjectDid: string): Promise<void> {
  throw new Error('Following is disabled: app is restricted to read-only Bluesky and writing only to its own lexicon.');
}
