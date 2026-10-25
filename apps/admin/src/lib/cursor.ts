import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";

/**
 * Cursor pagination for feeds the API pages with an opaque cursor token (audit
 * today). The hook flattens pages for tables and exposes `hasMore` + `loadMore`
 * for the "Load more" affordance.
 */
export interface CursorPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor: string | null;
}

export function useCursorFeed<Row>(
  options: Readonly<{
    queryKey: readonly unknown[];
    fetchPage: (cursor: string | undefined) => Promise<CursorPage<Row>>;
    enabled?: boolean;
  }>,
): Readonly<{
  rows: readonly Row[];
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  error: unknown;
}> {
  const query = useInfiniteQuery({
    queryKey: options.queryKey,
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => options.fetchPage(pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  return {
    rows: query.data?.pages.flatMap((page) => page.rows) ?? [],
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage) void query.fetchNextPage();
    },
    isLoading: query.isLoading,
    error: query.error,
  };
}
