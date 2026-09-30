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

// Helper function to automatically resolve intermediate pages to direct MP4 download link
async function resolveFinalDirectLink(initialUrl) {
    try {
        if (!initialUrl || !initialUrl.startsWith('http')) return initialUrl;

        // If it's already a direct video file link, return immediately
        if (/\.(mp4|mkv)(\?.*)?$/i.test(initialUrl) && !initialUrl.includes('csplayer') && !initialUrl.includes('zt-links')) {
            return initialUrl;
        }

        // Step 1: Request zt-links / landing page
        let currentData = '';
        try {
            const res1 = await axios.get(initialUrl, { headers, timeout: 8000 });
            currentData = res1.data;
        } catch {
            return initialUrl;
        }

        let $ = cheerio.load(currentData);
        
        // Find "Go to Download Page" or csplayer link
        let nextUrl = $('a[href*="csplayer"], a[href*="drive."], a:contains("Download Page")').first().attr('href');
        
        if (!nextUrl) {
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (href && (href.includes('csplayer') || href.includes('/server') || href.includes('drive.'))) {
                    if (!nextUrl) nextUrl = href;
                }
            });
        }

        if (!nextUrl) return initialUrl;

        // Step 2: Request csplayer / server download page
        try {
            const res2 = await axios.get(nextUrl, { headers, timeout: 8000 });
            $ = cheerio.load(res2.data);
            
            let finalDirectLink = '';
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                const text = $(el).text();
                
                // Catch Direct Download 1 / 2 links (e.g. supercloud / mp4 links)
                if (href && (href.includes('supercloud') || href.includes('.mp4') || href.includes('.mkv') || /direct download/i.test(text))) {
                    if (!finalDirectLink && href.startsWith('http')) {
                        finalDirectLink = href;
                    }
                }
            });

            return finalDirectLink || nextUrl;
        } catch {
            return nextUrl;
        }
    } catch {
        return initialUrl;
    }
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

// Movie Endpoint with Direct Video Resolution
fastify.get('/api/movie', async (request, reply) => {
    try {
        const movieUrl = request.query.url;
        if (!movieUrl) return reply.status(400).send({ status: false, error: 'URL required' });

        const { data } = await axios.get(movieUrl, { headers, timeout: 15000 });
        const $ = cheerio.load(data);

        const title = $('h1.entry-title, h1.title-post, h1').first().text().trim();
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
