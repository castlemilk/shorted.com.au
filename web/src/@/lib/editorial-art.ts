/** Reviewed static news art. Unknown or external images keep their original URL. */
export const NEWS_ART_THUMBNAILS: Readonly<Record<string, string>> = Object.freeze({
  "https://shorted.com.au/assets/news/nxt-shorts-8pc-into-40pc-fall-jemena-m3-delay/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/nxt-shorts-8pc-into-40pc-fall-jemena-m3-delay/thumbnail-editorial-v1.webp",
  "https://shorted.com.au/assets/news/crowded-exits-dmp-twe-edv-days-to-cover/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/crowded-exits-dmp-twe-edv-days-to-cover/thumbnail-editorial-v1.webp",
  "https://shorted.com.au/assets/news/australia-fuel-security-33-days-diesel-hormuz-october-2026/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/australia-fuel-security-33-days-diesel-hormuz-october-2026/thumbnail-editorial-v1.webp",
  "https://shorted.com.au/assets/news/aya-shorts-tenfold-since-july-price-halves/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/aya-shorts-tenfold-since-july-price-halves/thumbnail-editorial-v1.webp",
  "https://shorted.com.au/assets/news/lithium-shorts-build-pls-ltr-cxo-price-slump/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/lithium-shorts-build-pls-ltr-cxo-price-slump/thumbnail-editorial-v1.webp",
  "https://shorted.com.au/assets/news/wtc-record-short-meets-asic-no-action/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/wtc-record-short-meets-asic-no-action/thumbnail-editorial-v1.webp",
  "https://shorted.com.au/assets/news/asx-shorts-broaden-downtrend-rba-october-2026/cover-editorial-v1.webp": "https://shorted.com.au/assets/news/asx-shorts-broaden-downtrend-rba-october-2026/thumbnail-editorial-v1.webp",
});

export function editorialThumbnailUrl(heroUrl: string): string {
  return Object.prototype.hasOwnProperty.call(NEWS_ART_THUMBNAILS, heroUrl)
    ? NEWS_ART_THUMBNAILS[heroUrl]!
    : heroUrl;
}
