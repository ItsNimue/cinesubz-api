import Fastify from 'fastify';
import axios from 'axios';
import * as cheerio from 'cheerio';

const fastify = Fastify({ logger: false });
const BASE_URL = 'https://cinesubz.co';
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// Search Endpoint
fastify.get('/api/search', async (request, reply) => {
    try {
        const query = request.query.q;
        if (!query) return reply.status(400).send({ status: false, error: 'Query required' });

        const { data } = await axios.get(`${BASE_URL}/?s=${encodeURIComponent(query)}`, { headers, timeout: 10000 });
        const $ = cheerio.load(data);
        const results = [];

        $('article, .result-item, .item').each((_, el) => {
            const title = $(el).find('.title a, h2 a, .entry-title a').text().trim();
            const link = $(el).find('.title a, h2 a, .entry-title a').attr('href');
            const image = $(el).find('img').attr('src') \vert{}\vert{}$(el).find('img').attr('data-src');
            if (title && link) results.push({ title, link, image });
        });

        return { status: true, result: results };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

// Movie Details Endpoint
fastify.get('/api/movie', async (request, reply) => {
    try {
        const movieUrl = request.query.url;
        if (!movieUrl) return reply.status(400).send({ status: false, error: 'URL required' });

        const { data } = await axios.get(movieUrl, { headers, timeout: 10000 });
        const $ = cheerio.load(data);

        const title = $('h1.entry-title, .title-post').text().trim();
        const poster = $('.poster img, .entry-content img').first().attr('src');
        const dl_links = [];

        $('a[href*="mega"], a[href*="drive"], a[href*="pixeldrain"], .download-link a').each((_, el) => {
            const quality = $(el).text().trim() || 'Download Link';
            const link = $(el).attr('href');
            if (link) dl_links.push({ quality, link });
        });

        return { status: true, result: { title, poster, dl_links } };
    } catch (err) {
        return reply.status(500).send({ status: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) console.error(err);
    else console.log(`🚀 Standalone API running on port ${PORT}`);
});
