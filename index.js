import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

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

        if (results.length === 0) {
            $('a[href*="/movies/"], a[href*="/tvshows/"]').each((_, el) => {
                const link = $(el).attr('href');
                let title = $(el).attr('title');
                if (!title) title = $(el).text().trim();

                const imgEl = $(el).find('img').first();
                let image = imgEl.attr('src');
                if (!image) image = imgEl.attr('data-src');
                if (!image) image = imgEl.attr('data-lazy-src');
                if (!image) image = '';

                if (title && link && !results.some(r => r.link === link)) {
                    results.push({
                        title: title.replace(/\s+/g, ' ').trim(),
                        link: link,
                        image: image
                    });
                }
            });
        }

        return { status: true, count: results.length, result: results };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

// Movie Details & Direct Quality Links Endpoint
fastify.get('/api/movie', async (request, reply) => {
    try {
        const movieUrl = request.query.url;
        if (!movieUrl) return reply.status(400).send({ status: false, error: 'URL required' });

        const { data } = await axios.get(movieUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);

        const title = $('h1.entry-title, h1.title-post, h1').first().text().trim();
        const posterEl = $('.poster img, .entry-content img, .post-thumbnail img').first();
        
        let poster = posterEl.attr('src');
        if (!poster) poster = posterEl.attr('data-src');
        if (!poster) poster = posterEl.attr('data-lazy-src');
        if (!poster) poster = '';

        const dl_links = [];

        // සැබෑ Download Links පමණක් Filter කර ලබා ගැනීම
        $('a').each((_, el) => {
            const link = $(el).attr('href');
            if (!link) return;

            // Internal page anchors (#) සහ invalid links ඉවත් කිරීම
            if (link.startsWith('#') || link.startsWith('javascript:') || link.includes('#directandtgdownload')) return;
            if (!link.startsWith('http://') && !link.startsWith('https://')) return;

            let text = $(el).text().trim();
            if (!text) text = $(el).attr('title');
            if (!text) text = '';

            // Section buttons / Header text ඉවත් කිරීම
            if (text.includes('Direct & Telegram') || text.includes('Download Links')) return;

            // Link එක Host domain එකකට (Pixeldrain, Mega, Drive etc.) හෝ Quality tag එකකට අයිතිදැයි බලයි
            const isDlDomain = /pixeldrain|mega\.nz|drive\.google|mediafire|gofile|workers\.dev|file|download/i.test(link);
            const hasQualityTag = /480p|720p|1080p|2160p|4k|hd|sd|mkv|mp4/i.test(text) || /480p|720p|1080p/i.test(link);

            if (isDlDomain || hasQualityTag) {
                let quality = text.replace(/\s+/g, ' ').trim();
                if (!quality) quality = 'Download Link';

                if (!dl_links.some(d => d.link === link)) {
                    dl_links.push({ quality, link });
                }
            }
        });

        return { status: true, result: { title, poster, dl_links } };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

const PORT = process.env.PORT ? process.env.PORT : 3000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) console.error(err);
    else console.log(`🚀 API running on port ${PORT}`);
});
