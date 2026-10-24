import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiRun, ReviewPublication } from '@open-mercato/cezar-api-client'
import { getReviewPublication, republishReview } from '@/api/client'
import { queryKeys } from '@/api/queries'
import { toast } from '@/components/ui/toaster'

/** One line for a PR review run: the analysis result and the publication state, kept apart. */
export function reviewPublicationText(state: ReviewPublication): string {
  const analysis = state.analysis === 'complete' ? 'Analysis complete' : 'Analysis incomplete'
  switch (state.publication) {
    case 'published':
      return `${analysis} · review published`
    case 'duplicate':
      return `${analysis} · review already on the PR`
    case 'stale':
      return `${analysis} · not published: the PR moved to a new HEAD`
    case 'blocked':
      return `${analysis} · publication blocked${state.reason ? `: ${state.reason}` : ''}`
    default:
      return `${analysis} · not published yet`
  }
}

export function ReviewPublicationLine({ run }: { run: ApiRun }) {
  const queryClient = useQueryClient()
  const key = [...queryKeys.runs.all, run.id, 'review-publication', run.status]
  const query = useQuery({
    queryKey: key,
    queryFn: () => getReviewPublication(run.id),
    enabled: run.workflowDef?.graph?.nodes.some((n) => n.type === 'github.review-comment') === true,
    retry: false,
  })
  const republish = useMutation({
    mutationFn: () => republishReview(run.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [...queryKeys.runs.all, run.id] }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const state = query.data
  if (!state) return null
  return (
    <div data-slot="review-publication" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{reviewPublicationText(state)}</span>
      {state.canRepublish ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          disabled={republish.isPending}
          onClick={() => republish.mutate()}
        >
          Retry publishing
        </button>
      ) : null}
    </div>
  )
}
