import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: false });
const BASE_URL = 'https://cinesubz.co';

// Web scraping බ්ලොක් නොවීමට Browser Headers එකතු කිරීම
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': BASE_URL
};

// Root Endpoint
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

        // 1. Primary Card Selectors
        $('article, .result-item, .item, .post, .movie, div[class*="item"]').each((_, el) => {
            const linkEl = $(el).find('a[href*="cinesubz"]').first().length ? 
                           $(el).find('a[href*="cinesubz"]').first() : 
                           $(el).find('.title a, h2 a, h3 a, .entry-title a, a').first();
            
            const title = linkEl.attr('title') || linkEl.text().trim() || $(el).find('.title, h2, h3').text().trim();
            const link = linkEl.attr('href');
            
            const imgEl = $(el).find('img').first();
            const image = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';

            if (title && link && link.includes('cinesubz') && !results.some(r => r.link === link)) {
                results.push({
                    title: title.replace(/\s+/g, ' ').trim(),
                    link: link,
                    image: image
                });
            }
        });

        // 2. Fallback Selector (පළමු ක්‍රමයෙන් හමු නොවුණහොත් direct links සෙවීම)
        if (results.length === 0) {
            $('a[href*="/movies/"], a[href*="/tvshows/"]').each((_, el) => {
                const link = $(el).attr('href');
                const title = $(el).attr('title') \vert{}\vert{}$(el).text().trim();
                const imgEl = $(el).find('img').first();
                const image = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';

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

// Movie Details Endpoint
fastify.get('/api/movie', async (request, reply) => {
    try {
        const movieUrl = request.query.url;
        if (!movieUrl) return reply.status(400).send({ status: false, error: 'URL required' });

        const { data } = await axios.get(movieUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);

        const title = $('h1.entry-title, h1.title-post, h1').first().text().trim();
        const posterEl = $('.poster img, .entry-content img, .post-thumbnail img').first();
        const poster = posterEl.attr('src') || posterEl.attr('data-src') || posterEl.attr('data-lazy-src') || '';
        const dl_links = [];

        $('a[href*="mega"], a[href*="drive"], a[href*="pixeldrain"], a[href*="download"], .download-link a').each((_, el) => {
            const quality = $(el).text().trim() \vert{}\vert{}$(el).attr('title') || 'Download Link';
            const link = $(el).attr('href');
            if (link && !dl_links.some(d => d.link === link)) {
                dl_links.push({ quality, link });
            }
        });

        return { status: true, result: { title, poster, dl_links } };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) console.error(err);
    else console.log(`🚀 API running on port ${PORT}`);
});
