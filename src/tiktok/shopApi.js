/**
 * Shop-scoped API calls. Every call gets a fresh-enough access token and the shop_cipher.
 * If a call still comes back 401 (expired, or replaced by a refresh elsewhere),
 * we force one refresh and try once more. 429s are retried inside requestWithRetry.
 */
import { requestWithRetry, ApiError } from './http.js';
import { getAccessToken, refreshAccessToken } from './tokens.js';

async function shopRequest(shop, opts, stats) {
  let token = await getAccessToken(shop.id);
  const send = (t) =>
    requestWithRetry(
      {
        ...opts,
        query: { ...opts.query, shop_cipher: shop.cipher },
        headers: { 'x-tts-access-token': t },
        rateLimited: true,
      },
      stats,
    );
  try {
    return await send(token);
  } catch (e) {
    if (!(e instanceof ApiError) || !e.isAuthError) throw e;
    token = await refreshAccessToken(shop.id, token);
    return send(token);
  }
}

/** One page of orders/search, sorted by update_time ascending. */
export function searchOrders(shop, { filters = {}, pageSize = 50, pageToken } = {}, stats) {
  return shopRequest(shop, {
    method: 'POST',
    path: '/api/v2/orders/search',
    query: { page_size: pageSize, page_token: pageToken },
    body: filters,
  }, stats);
}

export function getOrder(shop, orderId, stats) {
  return shopRequest(shop, { method: 'GET', path: `/api/v2/orders/${encodeURIComponent(orderId)}` }, stats);
}

export function getSellerCenterSummary(shop, stats) {
  return shopRequest(shop, { method: 'GET', path: '/api/v2/seller-center/summary' }, stats);
}
