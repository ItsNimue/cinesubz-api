import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const fastify = Fastify({
    logger: false
});

const BASE_URL = 'https://cinesubz.co';

const headers = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/140.0.0.0 Safari/537.36',

    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,image/apng,*/*;q=0.8',

    'Accept-Language': 'en-US,en;q=0.9',

    'Referer': `${BASE_URL}/`
};

const http = axios.create({
    timeout: 20000,
    maxRedirects: 8,
    headers,
    validateStatus: status =>
        status >= 200 && status < 400
});

const cache = new Map();

const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const MOVIE_CACHE_TTL = 2 * 60 * 1000;
const DIRECT_CACHE_TTL = 10 * 60 * 1000;

let browser = null;
let browserPromise = null;

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function absoluteUrl(value, base) {
    if (!value) return '';

    try {
        return new URL(value, base).href;
    } catch {
        return '';
    }
}

function normalize(value) {
    return cleanText(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cacheGet(key) {
    const item = cache.get(key);

    if (!item) return null;

    if (item.expires <= Date.now()) {
        cache.delete(key);
        return null;
    }

    return item.value;
}

function cacheSet(key, value, ttl) {
    cache.set(key, {
        value,
        expires: Date.now() + ttl
    });

    return value;
}

function extractYear(text) {
    const match = String(text || '').match(
        /\b((?:19|20)\d{2})\b/
    );

    return match?.[1] || '';
}

function isMovieUrl(url) {
    try {
        const pathname = new URL(url).pathname;

        return /^\/movies\/[^/]+\/?$/i.test(pathname);
    } catch {
        return false;
    }
}

function isAllowedCineSubzHost(url) {
    try {
        const hostname = new URL(url).hostname
            .toLowerCase()
            .replace(/^www\./, '');

        return (
            hostname === 'cinesubz.co' ||
            hostname === 'cinesubz.net' ||
            hostname === 'cinesubz.lk'
        );
    } catch {
        return false;
    }
}

async function fetchPage(url) {
    const response = await http.get(url);

    if (typeof response.data !== 'string') {
        throw new Error('Invalid HTML response');
    }

    return {
        html: response.data,
        finalUrl:
            response.request?.res?.responseUrl ||
            url
    };
}

/*
|--------------------------------------------------------------------------
| Browser
|--------------------------------------------------------------------------
*/

async function getBrowser() {
    if (browser) {
        try {
            if (browser.isConnected()) {
                return browser;
            }
        } catch {}
    }

    if (browserPromise) {
        return browserPromise;
    }

    browserPromise = chromium.launch({
        headless: true,

        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    });

    try {
        browser = await browserPromise;
        return browser;
    } finally {
        browserPromise = null;
    }
}

async function closeBrowser() {
    if (!browser) return;

    try {
        await browser.close();
    } catch {}

    browser = null;
}

/*
|--------------------------------------------------------------------------
| Search
|--------------------------------------------------------------------------
*/

fastify.get('/', async () => {
    return {
        status: true,
        message: 'CineSubz API is running successfully!',
        version: '2.0.0'
    };
});

fastify.get('/api/search', async (request, reply) => {
    try {
        const query = cleanText(request.query?.q);

        if (!query) {
            return reply.status(400).send({
                status: false,
                error: 'Query required'
            });
        }

        const cacheKey = `search:${normalize(query)}`;

        const cached = cacheGet(cacheKey);

        if (cached) {
            return {
                status: true,
                count: cached.length,
                result: cached
            };
        }

        const searchUrl =
            `${BASE_URL}/?s=${encodeURIComponent(query)}`;

        const page = await fetchPage(searchUrl);

        const $ = cheerio.load(page.html);

        const results = [];
        const seen = new Set();

        function addResult(href, title, image) {
            const link = absoluteUrl(
                href,
                page.finalUrl || BASE_URL
            );

            if (!link) return;
            if (!isMovieUrl(link)) return;

            const cleanTitle = cleanText(title);

            if (!cleanTitle) return;
            if (seen.has(link)) return;

            seen.add(link);

            results.push({
                title: cleanTitle,
                link,

                image: absoluteUrl(
                    image,
                    page.finalUrl || BASE_URL
                ),

                year: extractYear(
                    `${cleanTitle} ${link}`
                )
            });
        }

        $(
            'article, .result-item, .item, .post, .movie, ' +
            'div[class*="item"]'
        ).each((_, el) => {
            const linkEl = $(el)
                .find('a[href*="/movies/"]')
                .first();

            const fallback =
                linkEl.length
                    ? linkEl
                    : $(el).find('a').first();

            const href = fallback.attr('href');

            if (!href) return;

            let title =
                fallback.attr('title') ||
                fallback.text();

            if (!title) {
                title = $(el)
                    .find(
                        '.title, h2, h3, h4, .entry-title'
                    )
                    .first()
                    .text();
            }

            const imgEl = $(el)
                .find('img')
                .first();

            const image =
                imgEl.attr('src') ||
                imgEl.attr('data-src') ||
                imgEl.attr('data-lazy-src') ||
                '';

            addResult(
                href,
                title,
                image
            );
        });

        /*
         * Fallback
         */
        if (results.length === 0) {
            $('a[href*="/movies/"]').each((_, el) => {
                const href = $(el).attr('href');

                if (!href) return;

                let title =
                    $(el).attr('title') ||
                    $(el).text();

                title = cleanText(title);

                if (!title) {
                    try {
                        const pathname =
                            new URL(
                                href,
                                page.finalUrl || BASE_URL
                            ).pathname;

                        const slug =
                            pathname
                                .split('/')
                                .filter(Boolean)
                                .pop() || '';

                        title = slug
                            .replace(
                                /-sinhala-subtitles.*$/i,
                                ''
                            )
                            .replace(
                                /-english-subtitles.*$/i,
                                ''
                            )
                            .replace(
                                /-subtitles.*$/i,
                                ''
                            )
                            .replace(/-/g, ' ');
                    } catch {
                        title = '';
                    }
                }

                const imgEl = $(el)
                    .find('img')
                    .first();

                const image =
                    imgEl.attr('src') ||
                    imgEl.attr('data-src') ||
                    imgEl.attr('data-lazy-src') ||
                    '';

                addResult(
                    href,
                    title,
                    image
                );
            });
        }

        /*
         * Ranking
         */
        const queryNormalized =
            normalize(query);

        const queryTokens =
            queryNormalized
                .split(' ')
                .filter(Boolean);

        const requestedYear =
            query.match(
                /\b((?:19|20)\d{2})\b/
            )?.[1];

        const ranked = results
            .map(item => {
                const titleNormalized =
                    normalize(item.title);

                const titleTokens =
                    titleNormalized
                        .split(' ')
                        .filter(Boolean);

                let score = 0;

                if (
                    titleNormalized ===
                    queryNormalized
                ) {
                    score += 1000;
                }

                for (const token of queryTokens) {
                    if (titleTokens.includes(token)) {
                        score += 150;
                    } else if (
                        titleTokens.some(
                            t =>
                                t.startsWith(token) ||
                                token.startsWith(t)
                        )
                    ) {
                        score += 80;
                    }
                }

                if (
                    requestedYear &&
                    (
                        item.title.includes(
                            requestedYear
                        ) ||
                        item.link.includes(
                            requestedYear
                        )
                    )
                ) {
                    score += 300;
                }

                return {
                    item,
                    score
                };
            })
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .map(x => x.item);

        const finalResults =
            ranked.slice(0, 20);

        cacheSet(
            cacheKey,
            finalResults,
            SEARCH_CACHE_TTL
        );

        return {
            status: true,
            count: finalResults.length,
            result: finalResults
        };
    } catch (err) {
        console.error(
            'Search Error:',
            err.message
        );

        return reply.status(500).send({
            status: false,
            error: err.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| Extract movie page
|--------------------------------------------------------------------------
*/

async function extractMovie(movieUrl) {
    const page = await fetchPage(movieUrl);

    const $ = cheerio.load(page.html);

    const finalPageUrl =
        page.finalUrl || movieUrl;

    const title = cleanText(
        $('h1.entry-title').first().text() ||
        $('h1.title-post').first().text() ||
        $('h1').first().text() ||
        $('meta[property="og:title"]')
            .attr('content') ||
        $('title').first().text()
    );

    const posterEl = $(
        '.poster img, ' +
        '.entry-content img, ' +
        '.post-thumbnail img'
    ).first();

    const poster = absoluteUrl(
        posterEl.attr('src') ||
        posterEl.attr('data-src') ||
        posterEl.attr('data-lazy-src') ||
        $('meta[property="og:image"]')
            .attr('content') ||
        '',
        finalPageUrl
    );

    const dl_links = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
        const rawHref =
            cleanText(
                $(el).attr('href')
            );

        if (!rawHref) return;

        if (
            rawHref.startsWith('#') ||
            rawHref.startsWith('javascript:')
        ) {
            return;
        }

        const link =
            absoluteUrl(
                rawHref,
                finalPageUrl
            );

        if (!link) return;

        const text =
            cleanText(
                $(el).text()
            );

        const titleAttr =
            cleanText(
                $(el).attr('title')
            );

        const ariaLabel =
            cleanText(
                $(el).attr('aria-label')
            );

        const context = cleanText(
            `${text} ${titleAttr} ${ariaLabel}`
        );

        const isZtLink =
            /\/zt-links\//i.test(link);

        const qualityMatch =
            context.match(
                /(?:480p|576p|720p|1080p|1440p|2160p|4k)/i
            );

        const hasDownloadText =
            /download|direct|telegram|web[- ]?dl|webrip|bluray/i
                .test(context);

        const isKnownHost =
            /pixeldrain|mega\.nz|drive\.google|mediafire|gofile/i
                .test(link);

        if (
            !isZtLink &&
            !qualityMatch &&
            !hasDownloadText &&
            !isKnownHost
        ) {
            return;
        }

        if (seen.has(link)) return;

        seen.add(link);

        let quality =
            qualityMatch?.[0] ||
            context;

        quality = cleanText(quality);

        if (!quality || quality.length > 100) {
            quality = 'Download';
        }

        dl_links.push({
            quality,
            link,
            type:
                isZtLink
                    ? 'intermediate'
                    : 'direct'
        });
    });

    /*
     * Sort low -> high quality
     */
    dl_links.sort((a, b) => {
        const qa =
            Number(
                a.quality.match(
                    /\d{3,4}/
                )?.[0] || 99999
            );

        const qb =
            Number(
                b.quality.match(
                    /\d{3,4}/
                )?.[0] || 99999
            );

        return qa - qb;
    });

    return {
        title,
        poster,
        dl_links
    };
}

/*
|--------------------------------------------------------------------------
| Resolve zt-links -> actual file
|--------------------------------------------------------------------------
*/

function looksLikeMediaUrl(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    return (
        /\.(mp4|mkv|webm|avi|mov)(?:$|[?#])/i.test(
            lower
        ) ||
        /download/i.test(lower) &&
        (
            /file/i.test(lower) ||
            /media/i.test(lower)
        )
    );
}

function looksLikeBadUrl(url) {
    if (!url) return true;

    const lower = url.toLowerCase();

    return (
        lower.startsWith('blob:') ||
        lower.startsWith('data:') ||
        lower.includes('javascript:') ||
        lower.includes('/zt-links/')
    );
}

function scoreMediaUrl(url) {
    let score = 0;

    const lower = url.toLowerCase();

    if (/\.(mp4|mkv|webm)(?:$|[?#])/.test(lower)) {
        score += 100;
    }

    if (/download/.test(lower)) {
        score += 20;
    }

    if (/video|media|stream|file/.test(lower)) {
        score += 10;
    }

    if (/\.m3u8(?:$|[?#])/.test(lower)) {
        score -= 50;
    }

    if (/\.ts(?:$|[?#])/.test(lower)) {
        score -= 50;
    }

    return score;
}

async function resolveDirectLink(intermediateUrl) {
    const cacheKey =
        `direct:${intermediateUrl}`;

    const cached =
        cacheGet(cacheKey);

    if (cached) {
        return cached;
    }

    if (
        looksLikeMediaUrl(
            intermediateUrl
        )
    ) {
        return cacheSet(
            cacheKey,
            intermediateUrl,
            DIRECT_CACHE_TTL
        );
    }

    const browser =
        await getBrowser();

    const context =
        await browser.newContext({
            userAgent:
                headers['User-Agent'],

            viewport: {
                width: 1280,
                height: 720
            },

            javaScriptEnabled: true,

            ignoreHTTPSErrors: true
        });

    const page =
        await context.newPage();

    const candidates = new Map();

    const addCandidate = url => {
        if (!url) return;

        if (looksLikeBadUrl(url)) {
            return;
        }

        let normalized = url;

        try {
            normalized =
                new URL(
                    url,
                    intermediateUrl
                ).href;
        } catch {}

        if (
            !/^https?:\/\//i.test(
                normalized
            )
        ) {
            return;
        }

        if (
            !looksLikeMediaUrl(
                normalized
            )
        ) {
            return;
        }

        candidates.set(
            normalized,
            scoreMediaUrl(normalized)
        );
    };

    /*
     * Network responses
     */
    page.on(
        'response',
        response => {
            try {
                const url =
                    response.url();

                const contentType =
                    response.headers()[
                        'content-type'
                    ] || '';

                if (
                    /video|octet-stream/i.test(
                        contentType
                    )
                ) {
                    addCandidate(url);
                }

                if (
                    looksLikeMediaUrl(url)
                ) {
                    addCandidate(url);
                }
            } catch {}
        }
    );

    /*
     * Requests
     */
    page.on(
        'request',
        request => {
            try {
                const url =
                    request.url();

                if (
                    looksLikeMediaUrl(url)
                ) {
                    addCandidate(url);
                }
            } catch {}
        }
    );

    try {
        await page.goto(
            intermediateUrl,
            {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            }
        );

        /*
         * Let JS execute.
         */
        await page.waitForTimeout(
            2500
        );

        /*
         * Inspect links.
         */
        const hrefs =
            await page
                .locator('a[href]')
                .evaluateAll(
                    elements =>
                        elements.map(
                            el =>
                                el.href
                        )
                )
                .catch(() => []);

        for (const href of hrefs) {
            addCandidate(href);
        }

        /*
         * Inspect video/source elements.
         */
        const mediaSources =
            await page.evaluate(() => {
                const output = [];

                for (
                    const el of document.querySelectorAll(
                        'video, source'
                    )
                ) {
                    if (el.src) {
                        output.push(el.src);
                    }

                    const dataSrc =
                        el.getAttribute(
                            'data-src'
                        );

                    if (dataSrc) {
                        output.push(dataSrc);
                    }
                }

                return output;
            }).catch(() => []);

        for (
            const url of mediaSources
        ) {
            addCandidate(url);
        }

        /*
         * Inspect performance resources.
         */
        const resources =
            await page.evaluate(() =>
                performance
                    .getEntriesByType(
                        'resource'
                    )
                    .map(
                        item =>
                            item.name
                    )
            ).catch(() => []);

        for (
            const url of resources
        ) {
            addCandidate(url);
        }

        /*
         * Find buttons / download links.
         */
        const clickableCount =
            await page.locator(
                'button, a'
            ).count();

        for (
            let i = 0;
            i < Math.min(
                clickableCount,
                100
            );
            i++
        ) {
            const element =
                page.locator(
                    'button, a'
                ).nth(i);

            const text =
                cleanText(
                    await element
                        .innerText()
                        .catch(() => '')
                );

            if (
                !/download|get link|direct/i
                    .test(text)
            ) {
                continue;
            }

            try {
                const href =
                    await element
                        .getAttribute(
                            'href'
                        );

                addCandidate(
                    href
                );
            } catch {}

            /*
             * Click only download-style
             * elements.
             */
            try {
                await element.click({
                    timeout: 3000,
                    noWaitAfter: true
                });

                await page.waitForTimeout(
                    2000
                );
            } catch {}
        }

        /*
         * Final performance check
         */
        const finalResources =
            await page.evaluate(() =>
                performance
                    .getEntriesByType(
                        'resource'
                    )
                    .map(
                        item =>
                            item.name
                    )
            ).catch(() => []);

        for (
            const url of finalResources
        ) {
            addCandidate(url);
        }

        /*
         * Pick best candidate.
         */
        const sorted =
            [...candidates.entries()]
                .sort(
                    (a, b) =>
                        b[1] - a[1]
                );

        const best =
            sorted[0]?.[0] || null;

        if (best) {
            cacheSet(
                cacheKey,
                best,
                DIRECT_CACHE_TTL
            );

            return best;
        }

        return null;
    } finally {
        await page.close().catch(
            () => {}
        );

        await context.close().catch(
            () => {}
        );
    }
}

/*
|--------------------------------------------------------------------------
| Movie API
|--------------------------------------------------------------------------
*/

fastify.get('/api/movie', async (
    request,
    reply
) => {
    try {
        const movieUrl =
            cleanText(
                request.query?.url
            );

        if (!movieUrl) {
            return reply.status(400).send({
                status: false,
                error: 'URL required'
            });
        }

        if (
            !isAllowedCineSubzHost(
                movieUrl
            )
        ) {
            return reply.status(400).send({
                status: false,
                error:
                    'Invalid CineSubz URL'
            });
        }

        const cacheKey =
            `movie:${movieUrl}`;

        const cached =
            cacheGet(cacheKey);

        if (cached) {
            return {
                status: true,
                result: cached
            };
        }

        const result =
            await extractMovie(
                movieUrl
            );

        /*
         * Do not resolve every quality here.
         *
         * The bot calls /api/download
         * only for the selected quality.
         */

        cacheSet(
            cacheKey,
            result,
            MOVIE_CACHE_TTL
        );

        return {
            status: true,
            result
        };
    } catch (err) {
        console.error(
            'Movie Error:',
            err.message
        );

        return reply.status(500).send({
            status: false,
            error: err.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| Download resolver
|--------------------------------------------------------------------------
*/

fastify.get('/api/download', async (
    request,
    reply
) => {
    try {
        const url =
            cleanText(
                request.query?.url
            );

        if (!url) {
            return reply.status(400).send({
                status: false,
                error: 'URL required'
            });
        }

        /*
         * Direct URL
         */
        if (
            looksLikeMediaUrl(url)
        ) {
            return {
                status: true,
                result: {
                    directLink: url,
                    type: 'direct'
                }
            };
        }

        /*
         * Only allow CineSubz
         * intermediate links.
         */
        if (
            !isAllowedCineSubzHost(
                url
            )
        ) {
            return reply.status(400).send({
                status: false,
                error:
                    'Invalid download URL'
            });
        }

        const directLink =
            await resolveDirectLink(
                url
            );

        if (!directLink) {
            return reply.status(404).send({
                status: false,
                error:
                    'Direct media URL could not be resolved'
            });
        }

        return {
            status: true,
            result: {
                directLink,
                type: 'direct'
            }
        };
    } catch (err) {
        console.error(
            'Download Resolver Error:',
            err.message
        );

        return reply.status(500).send({
            status: false,
            error: err.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

fastify.get('/health', async () => {
    return {
        status: true,
        browser:
            browser?.isConnected?.() === true
    };
});

/*
|--------------------------------------------------------------------------
| Shutdown
|--------------------------------------------------------------------------
*/

const shutdown = async signal => {
    console.log(
        `${signal} received`
    );

    await closeBrowser();

    try {
        await fastify.close();
    } catch {}

    process.exit(0);
};

process.on(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdown('SIGINT')
);

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

const PORT =
    Number(
        process.env.PORT || 3000
    );

try {
    await fastify.listen({
        port: PORT,
        host: '0.0.0.0'
    });

    console.log(
        `🚀 CineSubz API running on port ${PORT}`
    );

    console.log(
        `🌐 Port: ${PORT}`
    );
} catch (err) {
    console.error(
        'Startup Error:',
        err
    );

    process.exit(1);
}
