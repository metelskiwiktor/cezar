import { describe, expect, it } from 'vitest'
import { reviewPublicationText } from './review-publication-line'

describe('reviewPublicationText', () => {
  const base = { analysis: 'complete', canRepublish: false } as const
  it('keeps the analysis result apart from the publication state', () => {
    expect(reviewPublicationText({ ...base, publication: 'published' })).toBe('Analysis complete · review published')
    expect(reviewPublicationText({ ...base, publication: 'duplicate' })).toBe('Analysis complete · review already on the PR')
    expect(reviewPublicationText({ ...base, publication: 'pending' })).toBe('Analysis complete · not published yet')
    expect(reviewPublicationText({ ...base, publication: 'stale' })).toMatch(/new HEAD/)
  })
  it('names the blocking reason and never claims success', () => {
    const text = reviewPublicationText({ ...base, publication: 'blocked', reason: 'the review contains a local path', canRepublish: true })
    expect(text).toBe('Analysis complete · publication blocked: the review contains a local path')
    expect(text).not.toMatch(/published/)
  })
})
