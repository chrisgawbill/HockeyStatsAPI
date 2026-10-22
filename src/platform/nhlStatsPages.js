/**
 * Paging for the NHL stats REST API (api.nhle.com/stats/rest), which returns
 * `{ data: [...], total }` and serves at most `limit` rows per request.
 */

const STATS_PAGE_SIZE = 100;
const MAX_STATS_PAGES = 50;

/**
 * Fetches every row of a stats query by calling `fetchPage(start, limit)` for
 * consecutive pages until a short page or `total` is reached. The query should
 * be sorted on a unique key so rows do not shift between pages.
 * @param {(start: number, limit: number) => Promise<any>} fetchPage - resolves to the page payload
 * @returns {Promise<{ data: any[], total: number }>}
 */
async function fetchAllStatsRows(fetchPage) {
  const rows = [];
  for (let page = 0; page < MAX_STATS_PAGES; page += 1) {
    const pagePayload = await fetchPage(
      page * STATS_PAGE_SIZE,
      STATS_PAGE_SIZE,
    );
    const pageRows = pagePayload?.data;
    if (!Array.isArray(pageRows)) {
      throw new Error('NHL stats payload has no data array');
    }
    rows.push(...pageRows);
    const totalRows = Number(pagePayload?.total);
    if (pageRows.length < STATS_PAGE_SIZE) break;
    if (Number.isFinite(totalRows) && rows.length >= totalRows) break;
  }
  return { data: rows, total: rows.length };
}

module.exports = { fetchAllStatsRows, STATS_PAGE_SIZE };
