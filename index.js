import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: false });
const BASE_URL = 'https://cinesubz.co';

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': BASE_URL
};

// Deep Scraper: Bypasses zt-links -> csplayer -> Extracts Direct MP4 Supercloud Video Link
async function resolveFinalDirectLink(initialUrl) {
    try {
        if (!initialUrl || !initialUrl.startsWith('http')) return initialUrl;

        // If already a direct mp4 link, return it
        if (/\.(mp4|mkv)(\?.*)?$/i.test(initialUrl) && !initialUrl.includes('csplayer') && !initialUrl.includes('zt-links')) {
            return initialUrl;
        }

        const reqHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': BASE_URL
        };

        // Step 1: Request zt-links page
        const res1 = await axios.get(initialUrl, { 
            headers: reqHeaders, 
            timeout: 12000, 
            maxRedirects: 10,
            validateStatus: () => true 
        });

        if (!res1.data || typeof res1.data !== 'string') return initialUrl;
        const html1 = res1.data;
        const $1 = cheerio.load(html1);

        let csPlayerUrl = '';
        $1('a').each((_, el) => {
            const href = $1(el).attr('href');
            if (href && (href.includes('csplayer') || href.includes('drive.') || href.includes('/server'))) {
                if (!csPlayerUrl) csPlayerUrl = href;
            }
        });

        // Regex fallback for step 1
        if (!csPlayerUrl) {
            const csMatch = html1.match(/https?:\/\/[^\s"'<>]*csplayer[^\s"'<>]*/i) ||
                           html1.match(/https?:\/\/[^\s"'<>]*drive\.[^\s"'<>]*/i);
            if (csMatch) csPlayerUrl = csMatch[0];
        }

        if (!csPlayerUrl) return initialUrl;

        // Step 2: Request csplayer page (e.g. drive.csplayer2.space)
        const res2 = await axios.get(csPlayerUrl, { 
            headers: { ...reqHeaders, Referer: initialUrl }, 
            timeout: 12000, 
            maxRedirects: 10,
            validateStatus: () => true 
        });

        if (!res2.data || typeof res2.data !== 'string') return csPlayerUrl;
        const html2 = res2.data;

        // Direct Regex Extraction from HTML Body for Supercloud Direct MP4 Video URL with Token
        const directSupercloudRegex = /https?:\/\/[^\s"'<>]+supercloud[^\s"'<>]+\.(mp4|mkv)\?[^\s"'<>]*/gi;
        const supercloudMatches = html2.match(directSupercloudRegex);

        if (supercloudMatches && supercloudMatches.length > 0) {
            return supercloudMatches[0];
        }

        // Fallback General Video Regex Match
        const generalVideoRegex = /https?:\/\/[^\s"'<>]+\.(mp4|mkv)(\?[^\s"'<>]*)?/gi;
        const genMatches = html2.match(generalVideoRegex);
        if (genMatches) {
            for (let m of genMatches) {
                if (!m.includes('cinesubz') && !m.includes('zt-links')) {
                    return m;
                }
            }
        }

        // Fallback Cheerio Extraction
        const $2 = cheerio.load(html2);
        let finalLink = '';
        $2('a').each((_, el) => {
            const href = $2(el).attr('href');
            if (href && (href.includes('supercloud') || href.includes('.mp4') || href.includes('.mkv'))) {
                if (!finalLink && href.startsWith('http')) finalLink = href;
            }
        });

        return finalLink || csPlayerUrl;

    } catch (err) {
        return initialUrl;
    }
}

fastify.get('/', async () => {
    return { status: true, message: 'CineSubz API is running successfully!' };
});

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

// Movie Endpoint
fastify.get('/api/movie', async (request, reply) => {
    try {
        const movieUrl = request.query.url;
        if (!movieUrl) return reply.status(400).send({ status: false, error: 'URL required' });

        const { data } = await axios.get(movieUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);

        // Fix Movie Title Extraction
        let title = $('h1.entry-title, h1.title-post, .entry-header h1').first().text().trim();
        if (!title || /direct & telegram/i.test(title)) {
            title = $('meta[property="og:title"]').attr('content') \vert{}\vert{} $('title').text().replace(/ - CineSubz.*/i, '').trim();
        }

        const posterEl = $('.poster img, .entry-content img, .post-thumbnail img, img[class*="poster"]').first();
        let poster = posterEl.attr('src') || posterEl.attr('data-src') || posterEl.attr('data-lazy-src') || '';

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

        // Resolve intermediate pages using raw HTML regex scraper
        const resolvedLinks = await Promise.all(
            rawLinks.map(async (item) => {
                const finalUrl = await resolveFinalDirectLink(item.link);
                return { quality: item.quality, link: finalUrl };
            })
        );

        const cleanedLinks = [];
        const seenQualities = new Map();

        resolvedLinks.forEach((item) => {
            let qName = item.quality;
            if (!seenQualities.has(qName)) {
                seenQualities.set(qName, 1);
                cleanedLinks.push({ quality: qName, link: item.link });
            } else {
                const count = seenQualities.get(qName) + 1;
                seenQualities.set(qName, count);
                cleanedLinks.push({ quality: `${qName} (Option ${count})`, link: item.link });
            }
        });

        return { status: true, result: { title, poster, dl_links: cleanedLinks } };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

const PORT = process.env.PORT ? process.env.PORT : 3000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) console.error(err);
    else console.log(`🚀 API running on port ${PORT}`);
});
