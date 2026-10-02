import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import crypto from 'crypto';

const fastify = Fastify({ logger: false });
const BASE_URL = 'https://cinesubz.co';

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': BASE_URL
};

fastify.get('/', async () => {
    return { status: true, message: 'CineSubz API is running successfully!' };
});

// <<CSPLAYER-START>>
// ============================================================
// LINK RESOLVER
// cinesubz.co movie page  ->  zt-links page  ->  csplayer page  ->  supercloud ...mp4?token=...
//
// zt-links page එකේ තියෙන්නේ fake host එකක් (උදා: google.com/server7/...mp4).
// ඒකේ host එක drive.csplayer2.space කරලා, .mp4 -> ?ext=mp4 කළාම real csplayer page එක.
// ඒ page එකේ encrypt කරපු payload 2ක් (Direct Download 1 / 2) තියෙනවා.
// ඒවා POST කරලා, එන AES encrypted URL එක decrypt කළාම token එකත් එක්ක final link එක.
// ============================================================

const PLAYER_ORIGIN = (process.env.CSPLAYER_ORIGIN || 'https://drive.csplayer2.space').replace(/\/+$/, '');
const EXTRA_KEYS = ['kasun', 'cinesubz.lk', 'CSPlayer', 'ravindu01manoj'];
const SERVER_FALLBACKS = ['1', '2', '3', '4', '5', '6', '8', '9', '7', '11'];
const STEP_TIMEOUT = 15000;

const playerAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
});

// CryptoJS.AES.decrypt(passphrase) එකටම සමාන (OpenSSL "Salted__" format, AES-256-CBC, MD5 key derivation)
function cryptoJsDecrypt(b64, pass) {
    try {
        const raw = Buffer.from(b64, 'base64');
        if (raw.length < 32 || raw.subarray(0, 8).toString('latin1') !== 'Salted__') return null;
        const salt = raw.subarray(8, 16);

        let derived = Buffer.alloc(0);
        let prev = Buffer.alloc(0);
        while (derived.length < 48) {
            prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass, 'utf8'), salt])).digest();
            derived = Buffer.concat([derived, prev]);
        }

        const decipher = crypto.createDecipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
        return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isPlayerLike = (u) => /csplayer/i.test(hostOf(u)) || /\/server\d+\//i.test(u);
const isDirectFile = (u) => /\.(mp4|mkv)(\?.*)?$/i.test(u) && !/csplayer|zt-links|\/server\d+\//i.test(u);
const isExternalHost = (u) => /pixeldrain|mega\.nz|mediafire|gofile|drive\.google|telegram\.me|t\.me\//i.test(u);

// fake/පරණ host එකක් තියෙන link එකක් -> real csplayer page URL එක
function toPlayerUrl(raw) {
    let u = String(raw || '').trim().replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(u)) return null;

    u = u.replace(/^https?:\/\/([^\/]+)/i, (m, host) => (/csplayer/i.test(host) ? m : PLAYER_ORIGIN));
    u = u.replace(/(server\d+\/)\d+:\//, '$1');
    if (/\.mp4$/i.test(u) && !u.includes('?ext=')) u = u.replace(/\.mp4$/i, '?ext=mp4');
    return u;
}

// zt-links page HTML එකෙන් csplayer page link එක හොයනවා
function extractPlayerUrl(html, baseUrl) {
    const anchors = [];
    for (const m of String(html || '').matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let href = m[1].replace(/&amp;/g, '&').trim();
        try { href = new URL(href, baseUrl).href; } catch { continue; }
        anchors.push({ href, text: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() });
    }

    const pick =
        anchors.find(a => /csplayer/i.test(hostOf(a.href))) ||
        anchors.find(a => /\/server\d+\//i.test(a.href)) ||
        anchors.find(a => /download page/i.test(a.text));

    return pick ? toPlayerUrl(pick.href) : null;
}

// csplayer page එකෙන් final (token සහිත) download links ටික ගන්නවා
async function resolvePlayerLinks(playerUrl) {
    const serverMatch = playerUrl.match(/server(\d+)/);
    const serversToTry = [];
    if (serverMatch) {
        serversToTry.push(serverMatch[1]);
        SERVER_FALLBACKS.forEach(n => { if (!serversToTry.includes(n)) serversToTry.push(n); });
    } else {
        serversToTry.push('');
    }

    for (const serverNum of serversToTry) {
        const pageUrl = serverMatch ? playerUrl.replace(/server\d+/, `server${serverNum}`) : playerUrl;

        try {
            const parsed = new URL(pageUrl);
            const domain = parsed.origin;
            const currentPath = parsed.pathname + parsed.search;

            const baseHeaders = {
                'User-Agent': headers['User-Agent'],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            };

            const first = await axios.get(pageUrl, { httpsAgent: playerAgent, headers: baseHeaders, timeout: STEP_TIMEOUT });
            let cookie = (first.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

            let html = String(first.data || '');
            let realPageUrl = pageUrl;
            const hexRegex = /[0-9a-fA-F]{200,}/g;
            let payloads = html.match(hexRegex) || [];

            // payload නැත්නම් /api/download-data එකෙන් real page එකට redirect වෙනවද බලනවා
            if (payloads.length === 0) {
                const api = await axios.get(`${domain}/api/download-data${currentPath}`, {
                    httpsAgent: playerAgent,
                    timeout: STEP_TIMEOUT,
                    headers: { ...baseHeaders, 'Accept': 'application/json', 'Referer': pageUrl, 'Cookie': cookie }
                });
                if (api.headers['set-cookie']) cookie = api.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

                if (api.data && api.data.redirect) {
                    realPageUrl = api.data.redirect.startsWith('http') ? api.data.redirect : domain + api.data.redirect;
                    const page = await axios.get(realPageUrl, {
                        httpsAgent: playerAgent,
                        timeout: STEP_TIMEOUT,
                        headers: { ...baseHeaders, 'Referer': pageUrl, 'Cookie': cookie }
                    });
                    html = String(page.data || '');
                    payloads = html.match(hexRegex) || [];
                }
            }

            if (payloads.length === 0) continue;
            payloads = [...new Set(payloads)];

            const keys = [...new Set([...html.matchAll(/(["'])(.*?)\1/g)].map(m => m[2]))];
            keys.push(...EXTRA_KEYS);

            const found = [];
            for (const hex of payloads) {
                try {
                    const res = await axios.post(realPageUrl, Buffer.from(hex, 'hex'), {
                        httpsAgent: playerAgent,
                        timeout: STEP_TIMEOUT,
                        responseType: 'arraybuffer',
                        headers: {
                            'User-Agent': baseHeaders['User-Agent'],
                            'Accept': '*/*',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Connection': 'keep-alive',
                            'Content-Type': 'application/octet-stream',
                            'Cookie': cookie,
                            'Origin': domain,
                            'Referer': realPageUrl,
                            'Sec-Fetch-Dest': 'empty',
                            'Sec-Fetch-Mode': 'cors',
                            'Sec-Fetch-Site': 'same-origin'
                        }
                    });

                    const enc = Buffer.from(res.data).toString('utf8').match(/U2FsdGVkX1[a-zA-Z0-9+/=]+/);
                    if (!enc) continue;

                    for (const key of keys) {
                        if (!key || key.length < 3) continue;
                        let out = cryptoJsDecrypt(enc[0], key);
                        if (out && !out.startsWith('http')) {
                            try { out = Buffer.from(out, 'base64').toString('utf8'); } catch {}
                        }
                        if (out && /^https?:\/\//i.test(out)) { found.push(out.trim()); break; }
                    }
                } catch {}
            }

            const unique = [...new Set(found)];
            if (unique.length > 0) return unique;
        } catch {
            continue;
        }
    }
    return [];
}

// Any link -> { link, links, page, resolved }
//   link     : final direct link (token සහිත) - Direct Download 1
//   links    : සියලුම direct options (Direct Download 1, 2 ...)
//   page     : csplayer page URL (token expire වුනොත් /api/resolve?url=<page> එකෙන් අලුත් එකක් ගන්න)
//   resolved : final link එක ලැබුනාද
async function resolveFinalDirectLink(initialUrl) {
    const fail = (link, page = null) => ({ link, links: [], page, resolved: false });

    try {
        if (!initialUrl || !/^https?:\/\//i.test(initialUrl)) return fail(initialUrl);

        // දැනටමත් direct file එකක් (supercloud ...mp4?token=...) හෝ වෙන host එකක් (pixeldrain, mega ...)
        if (isDirectFile(initialUrl) || isExternalHost(initialUrl)) {
            return { link: initialUrl, links: [initialUrl], page: null, resolved: true };
        }

        let playerUrl = null;

        if (isPlayerLike(initialUrl)) {
            playerUrl = toPlayerUrl(initialUrl);
        } else {
            // zt-links වගේ intermediate page එකක්
            try {
                const res = await axios.get(initialUrl, { headers, timeout: 10000 });
                playerUrl = extractPlayerUrl(res.data, initialUrl);
            } catch {
                return fail(initialUrl);
            }
        }

        if (!playerUrl) return fail(initialUrl);

        const links = await resolvePlayerLinks(playerUrl);
        if (links.length === 0) return fail(playerUrl, playerUrl);

        return { link: links[0], links, page: playerUrl, resolved: true };
    } catch {
        return fail(initialUrl);
    }
}
// <<CSPLAYER-END>>

// ============================================================
// TV SHOW HELPERS
// ============================================================

function absoluteUrl(href, baseUrl) {
    try {
        return new URL(String(href || '').trim(), baseUrl).href;
    } catch {
        return null;
    }
}

function cleanText(value = '') {
    return String(value).replace(/\s+/g, ' ').trim();
}

function extractImage($, root) {
    const img = $(root).find('img').first();

    return (
        img.attr('src') ||
        img.attr('data-src') ||
        img.attr('data-lazy-src') ||
        ''
    );
}

function isTvShowUrl(url) {
    return /\/tvshows\//i.test(String(url || ''));
}

function isSeasonUrl(url) {
    return /\/tvshows\/.+\/Season\d+/i.test(String(url || ''));
}

function isEpisodeUrl(url) {
    return /\/episodes\//i.test(String(url || ''));
}

// Search Endpoint
fastify.get('/api/search', async (request, reply) => {
    try {
        const query = request.query.q;
        if (!query) return reply.status(400).send({ status: false, error: 'Query required' });

        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);
        const results = [];

        $('article, .result-item, .item, .post, .movie, div[class*="item"]').each((_, el) => {
            const linkEl = $(el).find('a[href*="cinesubz"]').first().length ? 
                           $(el).find('a[href*="cinesubz"]').first() : 
                           $(el).find('.title a, h2 a, h3 a, .entry-title a, a').first();
            
            let title = linkEl.attr('title');
            if (!title) title = linkEl.text().trim();
            if (!title) title = $(el).find('.title, h2, h3').text().trim();

            const link = linkEl.attr('href');
            
            const imgEl = $(el).find('img').first();
            let image = imgEl.attr('src');
            if (!image) image = imgEl.attr('data-src');
            if (!image) image = imgEl.attr('data-lazy-src');
            if (!image) image = '';

            if (title && link && link.includes('cinesubz') && !results.some(r => r.link === link)) {
                results.push({
                    title: title.replace(/\s+/g, ' ').trim(),
                    link: link,
                    image: image
                });
            }
        });

        return { status: true, count: results.length, result: results };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

// ============================================================
// TV SHOW DETAILS
// TV Show page -> Seasons
// ============================================================

fastify.get('/api/tv', async (request, reply) => {
    try {
        const tvUrl = request.query.url;

        if (!tvUrl) {
            return reply.status(400).send({
                status: false,
                error: 'URL required'
            });
        }

        if (!/\/tvshows\//i.test(tvUrl)) {
            return reply.status(400).send({
                status: false,
                error: 'Invalid TV Show URL'
            });
        }

        const response = await axios.get(tvUrl, {
            headers,
            timeout: 15000,
            maxRedirects: 10
        });

        const $ = cheerio.load(response.data);

        // ----------------------------------------------------
        // Canonical URL after redirects
        // cinesubz.co -> cinesubz.net වගේ redirect එකක් තිබුණොත්
        // final URL එක භාවිතා කරනවා.
        // ----------------------------------------------------

        let pageUrl = tvUrl;

        try {
            const finalUrl = response.request?.res?.responseUrl;

            if (finalUrl && /^https?:\/\//i.test(finalUrl)) {
                pageUrl = finalUrl;
            }
        } catch {}

        pageUrl = pageUrl.replace(/\/+$/, '');

        // ----------------------------------------------------
        // TITLE
        // ----------------------------------------------------

        let title = $(
            'h1.entry-title, h1.title-post, h1'
        ).first().text().trim();

        if (!title || /download links?/i.test(title)) {
            title =
                $('meta[property="og:title"]').attr('content') ||
                $('title').text() ||
                '';

            title = title
                .replace(/\s*[|–-]\s*cine\s*subz.*$/i, '')
                .trim();
        }

        title = title.replace(/\s+/g, ' ').trim();

        // ----------------------------------------------------
        // POSTER
        // ----------------------------------------------------

        const posterEl = $(
            '.poster img, ' +
            '.entry-content img, ' +
            '.post-thumbnail img, ' +
            'img[class*="poster"]'
        ).first();

        let poster =
            posterEl.attr('src') ||
            posterEl.attr('data-src') ||
            posterEl.attr('data-lazy-src') ||
            '';

        if (poster) {
            try {
                poster = new URL(poster, pageUrl).href;
            } catch {}
        }

        // ----------------------------------------------------
        // SEASONS
        //
        // IMPORTANT:
        // CineSubz current TV page එකේ Season buttons වලට
        // direct href එකක් නැති නිසා text එකෙන් season number
        // අරගෙන:
        //
        // /tvshows/.../Season01
        // /tvshows/.../Season02
        //
        // generate කරනවා.
        // ----------------------------------------------------

        const seasonNumbers = new Set();

        // 1. Season button text
        $('button, a, [class*="season"], [id*="season"]').each((_, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();

            const matches = [
                ...text.matchAll(/\bSeason\s*0*(\d{1,2})\b/gi)
            ];

            for (const match of matches) {
                seasonNumbers.add(parseInt(match[1], 10));
            }

            // data attributes තිබුණොත් ඒවත් බලනවා
            for (const attr of [
                'data-season',
                'data-season-number',
                'data-season-id'
            ]) {
                const value = $(el).attr(attr);

                if (value && /^\d+$/.test(value)) {
                    seasonNumbers.add(parseInt(value, 10));
                }
            }
        });

        // 2. Page text එකෙන් fallback ලෙස seasons හොයනවා
        const bodyText = $('body')
            .text()
            .replace(/\s+/g, ' ');

        for (const match of bodyText.matchAll(
            /\bSeason\s*0*(\d{1,2})\b/gi
        )) {
            seasonNumbers.add(
                parseInt(match[1], 10)
            );
        }

        // ----------------------------------------------------
        // BUILD SEASON URLS
        // ----------------------------------------------------

        const seasons = [...seasonNumbers]
            .filter(n => n >= 1 && n <= 100)
            .sort((a, b) => a - b)
            .map(number => ({
                season: number,
                title: `Season ${String(number).padStart(2, '0')}`,
                link: `${pageUrl}/Season${String(number).padStart(2, '0')}`
            }));

        return {
            status: true,
            result: {
                title,
                poster,
                seasons
            }
        };

    } catch (err) {
        console.error(
            'TV Details Error:',
            err.message
        );

        return reply.status(500).send({
            status: false,
            error: err.message
        });
    }
});

// ============================================================
// TV SEASON
// Season page -> Only that season's episodes
// ============================================================

fastify.get('/api/tv/season', async (request, reply) => {
    try {
        const seasonUrl = request.query.url;

        if (!seasonUrl) {
            return reply.status(400).send({
                status: false,
                error: 'URL required'
            });
        }

        if (!/\/tvshows\/.+\/Season\d+/i.test(seasonUrl)) {
            return reply.status(400).send({
                status: false,
                error: 'Invalid Season URL'
            });
        }

        // Requested season number
        const seasonMatch = seasonUrl.match(/\/Season0*(\d+)(?:\/)?$/i);

        if (!seasonMatch) {
            return reply.status(400).send({
                status: false,
                error: 'Season number not found'
            });
        }

        const requestedSeason = parseInt(seasonMatch[1], 10);

        const response = await axios.get(seasonUrl, {
            headers,
            timeout: 15000,
            maxRedirects: 10
        });

        const $ = cheerio.load(response.data);

        // --------------------------------------------------------
        // Title
        // --------------------------------------------------------

        let title = $('h1.entry-title, h1.title-post, h1')
            .first()
            .text()
            .trim();

        if (!title || /download links?/i.test(title)) {
            title =
                $('meta[property="og:title"]').attr('content') ||
                $('title').text() ||
                '';
        }

        title = title
            .replace(/\s+/g, ' ')
            .trim();

        // --------------------------------------------------------
        // Find episodes
        // --------------------------------------------------------

        const episodes = [];
        const seen = new Set();

        $('a[href*="/episodes/"]').each((_, el) => {
            const href = $(el).attr('href');

            if (!href) return;

            let link;

            try {
                link = new URL(href, seasonUrl).href;
            } catch {
                return;
            }

            // ----------------------------------------------------
            // Detect season + episode from URL
            //
            // game-of-thrones-1x3
            // game-of-thrones-2x10
            // game-of-thrones-s01-e01
            // ----------------------------------------------------

            let episodeSeason = null;
            let episodeNumber = null;

            let match = link.match(
                /[-_/]s0*(\d{1,2})[-_]?e0*(\d{1,3})(?:[-_/]|$)/i
            );

            if (match) {
                episodeSeason = parseInt(match[1], 10);
                episodeNumber = parseInt(match[2], 10);
            }

            if (!match) {
                match = link.match(
                    /[-_/]0*(\d{1,2})x0*(\d{1,3})(?:[-_/]|$)/i
                );

                if (match) {
                    episodeSeason = parseInt(match[1], 10);
                    episodeNumber = parseInt(match[2], 10);
                }
            }

            // Could not detect episode
            if (
                episodeSeason === null ||
                episodeNumber === null
            ) {
                return;
            }

            // ----------------------------------------------------
            // IMPORTANT:
            // Only return requested season
            // ----------------------------------------------------

            if (episodeSeason !== requestedSeason) {
                return;
            }

            // Prevent duplicates
            if (seen.has(link)) return;
            seen.add(link);

            let episodeTitle = $(el)
                .text()
                .replace(/\s+/g, ' ')
                .trim();

            // Remove leading episode number
            episodeTitle = episodeTitle
                .replace(
                    new RegExp(
                        `^${episodeNumber}\\s*`,
                        'i'
                    ),
                    ''
                )
                .trim();

            // Remove date at the end
            episodeTitle = episodeTitle
                .replace(
                    /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},\s+\d{4}\s*$/i,
                    ''
                )
                .trim();

            if (!episodeTitle) {
                episodeTitle = `Episode ${String(episodeNumber).padStart(2, '0')}`;
            }

            episodes.push({
                season: episodeSeason,
                episode: episodeNumber,
                title: episodeTitle,
                link
            });
        });

        // --------------------------------------------------------
        // Sort episodes
        // --------------------------------------------------------

        episodes.sort(
            (a, b) => a.episode - b.episode
        );

        return {
            status: true,
            result: {
                title,
                season: requestedSeason,
                episodes
            }
        };

    } catch (err) {
        console.error(
            'TV Season Error:',
            err.message
        );

        return reply.status(500).send({
            status: false,
            error: err.message
        });
    }
});

// ============================================================
// TV EPISODE
// Episode page -> Quality -> Direct Links
//
// Example:
// /api/tv/episode?url=https://cinesubz.co/episodes/game-of-thrones-s01-e01/
// ============================================================

fastify.get('/api/tv/episode', async (request, reply) => {
    try {
        const episodeUrl = request.query.url;

        if (!episodeUrl) {
            return reply.status(400).send({
                status: false,
                error: 'URL required'
            });
        }

        if (!isEpisodeUrl(episodeUrl)) {
            return reply.status(400).send({
                status: false,
                error: 'Invalid Episode URL'
            });
        }

        const { data } = await axios.get(episodeUrl, {
            headers,
            timeout: 15000
        });

        const $ = cheerio.load(data);

        // ----------------------------------------------------
        // Title
        // ----------------------------------------------------

        let title =
            $('h1.entry-title, h1.title-post, h1').first().text().trim();

        if (!title || /download links?/i.test(title)) {
            title =
                $('meta[property="og:title"]').attr('content') ||
                $('title').text() ||
                '';

            title = title
                .replace(/\s*[|–-]\s*cine\s*subz.*$/i, '')
                .trim();
        }

// ----------------------------------------------------
// Episode title
// ----------------------------------------------------

let episodeTitle = '';

const episodeTitleSelectors = [
    '.episodetitle',
    '.episode-title',
    '.episode-title h1',
    '.episode-title h2',
    '.entry-title',
    '.entry-header h1'
];

for (const selector of episodeTitleSelectors) {
    const value = cleanText(
        $(selector).first().text()
    );

    if (
        value &&
        value.length < 200 &&
        !/download links?|facebook|twitter|comments|cinesubz|telegram|privacy policy/i.test(value)
    ) {
        episodeTitle = value;
        break;
    }
}

// ----------------------------------------------------
// Fallback:
// Current CineSubz page contains something like:
//
// 1×1 Winter Is Coming Serie:Game of Thrones Year:2011
//
// Extract only the text between episode number and "Serie:"
// ----------------------------------------------------

if (!episodeTitle) {
    const bodyText = cleanText(
        $('body').text()
    );

    const match = bodyText.match(
        /\b\d{1,2}×\d{1,3}\s+(.+?)\s+Serie\s*:/i
    );

    if (match) {
        episodeTitle = cleanText(match[1]);
    }
}

// ----------------------------------------------------
// Final fallback
// ----------------------------------------------------

if (!episodeTitle) {
    episodeTitle = episode !== null
        ? `Episode ${String(episode).padStart(2, '0')}`
        : 'Episode';
}

        // ----------------------------------------------------
        // Episode number
        // ----------------------------------------------------

        let season = null;
        let episode = null;

        let epMatch = episodeUrl.match(
            /[-_]s0*(\d{1,2})[-_]?e0*(\d{1,3})(?:[/?#]|$)/i
        );

        if (epMatch) {
            season = parseInt(epMatch[1], 10);
            episode = parseInt(epMatch[2], 10);
        }

       if (!epMatch) {
       epMatch = episodeUrl.match(
           /[-_]0*(\d{1,2})x0*(\d{1,3})(?:[/?#]|$)/i
       );

       if (epMatch) {
           season = parseInt(epMatch[1], 10);
           episode = parseInt(epMatch[2], 10);
       }
   }

        // ----------------------------------------------------
        // Poster
        // ----------------------------------------------------

        const poster = extractImage(
            $,
            '.poster, .entry-content, .post-thumbnail, article'
        );

        // ----------------------------------------------------
        // Download links
        // ----------------------------------------------------

        const rawLinks = [];

        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');

            if (!href || !/^https?:\/\//i.test(href)) return;

            const text = cleanText($(el).text());

            const parentText = cleanText(
                $(el)
                    .closest('div, p, li, tr, td, article')
                    .text()
            );

            const combinedText = `${text} ${parentText}`;

            // Social / navigation links ignore
            if (
                /facebook|twitter|whatsapp|pinterest|tumblr|telegram\.me|t\.me\/share/i.test(href) ||
                /\/category\/|\/genre\/|\/tag\/|\/actor\/|\/director\/|\/author\/|\/year\/|\/quality\/|\/languages\//i.test(href)
            ) {
                return;
            }

            const hasResolution =
                /(480p|720p|1080p|2160p|4k)/i.test(combinedText);

            const isDownloadPath =
                /zt-links|csplayer|pixeldrain|mega\.nz|mediafire|gofile|drive\.google|\/download\/|\/links\/|\/api-/i.test(href);

            if (!hasResolution && !isDownloadPath) return;

            const resMatch =
                combinedText.match(/(480p|720p|1080p|2160p|4k)/i);

            const typeMatch =
                combinedText.match(/(WEB-DL|WEBRip|HDRip|BDRip|Bluray|HDTV)/i);

            const sizeMatch =
                combinedText.match(/(\d+(?:\.\d+)?\s*(?:MB|GB))/i);

            let quality = '';

            if (resMatch) {
                const res = resMatch[0].toUpperCase();
                const type = typeMatch
                    ? `${typeMatch[0].toUpperCase()} `
                    : '';

                const size = sizeMatch
                    ? ` - ${sizeMatch[0].toUpperCase()}`
                    : '';

                quality = `${type}${res}${size}`.trim();
            } else if (
                text &&
                text.length > 2 &&
                text.length < 80 &&
                !/direct & telegram/i.test(text)
            ) {
                quality = text;
            } else {
                quality = 'Download Link';
            }

            if (!rawLinks.some(x => x.link === href)) {
                rawLinks.push({
                    quality,
                    link: href
                });
            }
        });

        // ----------------------------------------------------
        // Resolve links using existing movie resolver
        // ----------------------------------------------------

        const resolvedLinks = await Promise.all(
            rawLinks.map(async item => {
                const resolved = await resolveFinalDirectLink(item.link);

                return {
                    quality: item.quality,
                    ...resolved
                };
            })
        );

        // ----------------------------------------------------
        // Keep duplicate quality links as fallback options
        // ----------------------------------------------------

        const cleanedLinks = [];
        const seenQualities = new Map();

        for (const item of resolvedLinks) {
            const baseQuality = item.quality || 'Download Link';

            if (!seenQualities.has(baseQuality)) {
                seenQualities.set(baseQuality, 1);

                cleanedLinks.push({
                    ...item,
                    quality: baseQuality
                });
            } else {
                const count =
                    seenQualities.get(baseQuality) + 1;

                seenQualities.set(baseQuality, count);

                cleanedLinks.push({
                    ...item,
                    quality: `${baseQuality} (Option ${count})`
                });
            }
        }

        return {
            status: true,
            result: {
                title: cleanText(title),
                episodeTitle,
                season,
                episode,
                poster,
                dl_links: cleanedLinks
            }
        };

    } catch (err) {
        console.error('TV Episode Error:', err.message);

        return reply.status(500).send({
            status: false,
            error: err.message
        });
    }
});

// Movie Endpoint with Direct Video Resolution
fastify.get('/api/movie', async (request, reply) => {
    try {
        const movieUrl = request.query.url;
        if (!movieUrl) return reply.status(400).send({ status: false, error: 'URL required' });

        const { data } = await axios.get(movieUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);

        let title = $('h1.entry-title, h1.title-post, h1').first().text().trim();
        // සමහර pages වල පළමු h1 එක "Direct & Telegram Download Links" වගේ section heading එකක්
        if (!title || /download links?/i.test(title)) {
            const ogTitle = ($('meta[property="og:title"]').attr('content') || $('title').text() || '').replace(/\s*[|–-]\s*cine\s*subz.*$/i, '').trim();
            if (ogTitle) title = ogTitle;
        }
        const posterEl = $('.poster img, .entry-content img, .post-thumbnail img, img[class*="poster"]').first();
        
        let poster = posterEl.attr('src');
        if (!poster) poster = posterEl.attr('data-src');
        if (!poster) poster = posterEl.attr('data-lazy-src');
        if (!poster) poster = '';

        const rawLinks = [];

        $('a').each((_, el) => {
            const link = $(el).attr('href');
            if (!link || !link.startsWith('http')) return;

            if (
                /facebook|twitter|whatsapp|pinterest|tumblr|telegram\.me|t\.me\/share/i.test(link) ||
                /\/category\/|\/genre\/|\/tag\/|\/actor\/|\/director\/|\/author\/|\/year\/|\/quality\/|\/languages\//i.test(link) ||
                link === BASE_URL || link === `${BASE_URL}/` || link === movieUrl
            ) return;

            const text = $(el).text().replace(/\s+/g, ' ').trim();
            const parentText = $(el).closest('div, p, li, tr, td, article').text().replace(/\s+/g, ' ').trim();
            const combinedText = `${text} ${parentText}`;

            const hasResolution = /(480p|720p|1080p|2160p|4k)/i.test(combinedText);
            const isDownloadPath = /zt-links|csplayer|pixeldrain|mega\.nz|mediafire|gofile|drive\.google|\/download\/|\/links\//i.test(link);

            if (hasResolution || isDownloadPath) {
                const resMatch = combinedText.match(/(480p|720p|1080p|2160p|4k)/i);
                const typeMatch = combinedText.match(/(WEB-DL|HDRip|BDRip|Bluray|HDTV)/i);
                const sizeMatch = combinedText.match(/(\d+(\.\d+)?\s*(MB|GB))/i);

                let quality = '';
                if (resMatch) {
                    const res = resMatch[0].toUpperCase();
                    const type = typeMatch ? `${typeMatch[0].toUpperCase()} ` : '';
                    const size = sizeMatch ? ` - ${sizeMatch[0].toUpperCase()}` : '';
                    quality = `${type}${res}${size}`.trim();
                } else if (text && text.length > 2 && text.length < 50 && !/direct & telegram/i.test(text)) {
                    quality = text;
                } else {
                    quality = 'Download Link';
                }

                if (!rawLinks.some((d) => d.link === link)) {
                    rawLinks.push({ quality, link });
                }
            }
        });

        // Automatically bypass intermediate pages to return direct .mp4 links
        const resolvedLinks = await Promise.all(
            rawLinks.map(async (item) => {
                const r = await resolveFinalDirectLink(item.link);
                return { quality: item.quality, ...r };
            })
        );

        const cleanedLinks = [];
        const seenQualities = new Map();

        resolvedLinks.forEach((item) => {
            let qName = item.quality;
            if (!seenQualities.has(qName)) {
                seenQualities.set(qName, 1);
                cleanedLinks.push({ ...item, quality: qName });
            } else {
                const count = seenQualities.get(qName) + 1;
                seenQualities.set(qName, count);
                cleanedLinks.push({ ...item, quality: `${qName} (Option ${count})` });
            }
        });

        return { status: true, result: { title, poster, dl_links: cleanedLinks } };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

// Resolve Endpoint - zt-links / csplayer link එකකින් අලුත් token සහිත direct link ගන්න
// (token expire වුනොත්, හෝ download කරන්න කලින් fresh එකක් ගන්න)
fastify.get('/api/resolve', async (request, reply) => {
    try {
        const url = request.query.url;
        if (!url) return reply.status(400).send({ status: false, error: 'URL required' });

        const result = await resolveFinalDirectLink(url);
        return { status: result.resolved, result };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

const PORT = process.env.PORT ? process.env.PORT : 3000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) console.error(err);
    else console.log(`🚀 API running on port ${PORT}`);
});
