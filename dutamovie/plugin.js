import { Voe } from "skystream-extractors";

(function () {
    const BASE = () => String(manifest.baseUrl || "https://revertsite.com").replace(/\/$/, "");
    const REFERER_HEADERS = () => ({ Referer: BASE() + "/" });
    const MAX_ITEMS = 48;

    function decodeHtml(value) {
        return String(value || "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#0*39;|&apos;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&nbsp;/g, " ")
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
            .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
    }

    function textOf(html) {
        return decodeHtml(String(html || "")
            .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/\s+/g, " ")).trim();
    }

    function attr(tag, name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = String(tag || "").match(new RegExp("\\b" + escaped + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
        return match ? decodeHtml(match[2]) : "";
    }

    function absoluteUrl(value, pageUrl) {
        const candidate = decodeHtml(String(value || "").trim());
        if (!candidate || candidate.charAt(0) === "#" || /^(?:javascript|data|blob):/i.test(candidate)) return "";
        try {
            const resolved = new URL(candidate, pageUrl || BASE() + "/");
            return /^https?:$/.test(resolved.protocol) ? resolved.href : "";
        } catch (_) {
            return "";
        }
    }

    function responseBody(response) {
        const body = response && response.body;
        return typeof body === "string" ? body : String(body || "");
    }

    async function requestPage(url) {
        const target = absoluteUrl(url, BASE() + "/");
        if (!target) throw new Error("URL Dutamovie tidak valid");
        let response;
        let status = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            response = await http_get(target, REFERER_HEADERS());
            status = Number(response && (response.status || response.statusCode));
            if (status < 500 || status >= 600 || attempt === 2) break;
        }
        if (!response || status < 200 || status >= 400) {
            throw new Error("Dutamovie mengembalikan HTTP " + (status || "tidak diketahui"));
        }
        return { html: responseBody(response), url: target };
    }

    function metaContent(html, key) {
        const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
        const tag = tags.find(value => {
            const property = attr(value, "property").toLowerCase();
            const name = attr(value, "name").toLowerCase();
            return property === key.toLowerCase() || name === key.toLowerCase();
        });
        return tag ? attr(tag, "content") : "";
    }

    function imageFrom(article, pageUrl) {
        const image = (String(article || "").match(/<img\b[^>]*>/i) || [""])[0];
        const srcset = attr(image, "srcset");
        const largestSource = srcset.split(",").map(candidate => {
            const match = candidate.trim().match(/^(\S+)\s+(\d+)w$/i);
            return match ? { url: match[1], width: Number(match[2]) } : null;
        }).filter(Boolean).sort((a, b) => b.width - a.width)[0];
        return absoluteUrl(attr(image, "data-src") || attr(image, "data-lazy-src")
            || (largestSource && largestSource.url) || attr(image, "src") || attr(image, "data-original"), pageUrl);
    }

    function scoreFrom(markup) {
        const match = String(markup || "").match(/class=["'][^"']*gmr-rating-item[^"']*["'][^>]*>([\s\S]*?)<\//i)
            || String(markup || "").match(/itemprop=["']ratingValue["'][^>]*content=["']([\d.]+)/i)
            || String(markup || "").match(/itemprop=["']ratingValue["'][^>]*>\s*([\d.]+)/i);
        const value = Number(textOf(match && match[1]));
        return Number.isFinite(value) && value > 0 ? value : undefined;
    }

    function itemType(url, markup) {
        // Site-wide detail HTML contains sidebar text like "TV Show" even for movies.
        // Dutamovie routes series and episodes under /tv/ and /eps/ respectively.
        return /\/(?:tv|eps)\//i.test(url) ? "series" : "movie";
    }

    function articleItem(article, pageUrl) {
        const titleLink = article.match(/<h[1-4]\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/h[1-4]>/i);
        const firstLink = titleLink ? (titleLink[0].match(/<a\b[^>]*>[\s\S]*?<\/a>/i) || [""])[0] : (article.match(/<a\b[^>]*>[\s\S]*?<\/a>/i) || [""])[0];
        const url = absoluteUrl(attr(firstLink, "href"), pageUrl);
        const title = textOf(firstLink) || attr(firstLink, "title");
        const posterUrl = imageFrom(article, pageUrl);
        if (!url || !title || !posterUrl) return null;

        const yearMatch = (title + " " + article).match(/\b(19|20)\d{2}\b/);
        const durationMatch = article.match(/gmr-duration-item[^>]*>([\s\S]*?)<\//i);
        const genreBlock = article.match(/class=["'][^"']*gmr-movie-on[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        const tags = genreBlock ? (genreBlock[1].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []).map(textOf).filter(Boolean) : [];
        const type = itemType(url, article);
        return new MultimediaItem({
            title,
            url,
            posterUrl,
            type,
            contentType: type,
            year: yearMatch ? Number(yearMatch[0]) : undefined,
            score: scoreFrom(article),
            duration: durationMatch ? Number((textOf(durationMatch[1]).match(/\d+/) || [])[0]) || undefined : undefined,
            tags,
            headers: REFERER_HEADERS()
        });
    }

    function collectArticles(html, pageUrl, limit) {
        const articles = String(html || "").match(/<article\b[\s\S]*?<\/article>/gi) || [];
        const items = [];
        const seen = new Set();
        for (const article of articles) {
            const item = articleItem(article, pageUrl);
            if (!item || seen.has(item.url)) continue;
            seen.add(item.url);
            items.push(item);
            if (items.length >= limit) break;
        }
        return items;
    }

    function homeCards(html) {
        const source = String(html || "");
        const blocks = [...source.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map(match => ({
            index: match.index,
            markup: match[0]
        }));

        // Dutamovie's home modules use schema.org card <div>s rather than <article>s.
        // Collect the complete card so its title, poster and metadata stay together.
        const divTokens = [...source.matchAll(/<div\b[^>]*>|<\/div\s*>/gi)];
        for (let i = 0; i < divTokens.length; i++) {
            const open = divTokens[i];
            if (/^<\//.test(open[0])) continue;
            if (!/\bitemscope\b/i.test(open[0]) || !/\bitemtype\s*=\s*["'][^"']*(?:Movie|TVSeries)/i.test(open[0])) continue;

            let depth = 1;
            let end = i + 1;
            for (; end < divTokens.length; end++) {
                if (/^<\//.test(divTokens[end][0])) depth--;
                else depth++;
                if (depth === 0) break;
            }
            if (depth === 0) {
                const finish = divTokens[end].index + divTokens[end][0].length;
                blocks.push({ index: open.index, markup: source.slice(open.index, finish) });
                i = end;
            }
        }
        return blocks.sort((a, b) => a.index - b.index);
    }

    function homeCategories(html, pageUrl) {
        const cards = homeCards(html);
        const headings = [...String(html || "").matchAll(/<h[23]\b([^>]*)>([\s\S]*?)<\/h[23]>/gi)]
            .filter(match => !/entry-title/i.test(attr("<h2 " + match[1] + ">", "class")))
            .map(match => ({ index: match.index, title: textOf(match[2]) }))
            .filter(entry => entry.title && entry.title.length < 60);
        const groups = {};
        const seen = new Set();
        for (const card of cards) {
            const item = articleItem(card.markup, pageUrl);
            if (!item || seen.has(item.url)) continue;
            seen.add(item.url);
            let category = "Terbaru";
            for (const heading of headings) {
                if (heading.index > card.index) break;
                category = heading.title;
            }
            category = category.replace(/\s+/g, " ").trim() || "Terbaru";
            if (!groups[category]) groups[category] = [];
            if (groups[category].length < 24) groups[category].push(item);
        }
        const categories = {};
        for (const name of Object.keys(groups)) {
            if (groups[name].length) categories[name] = groups[name];
        }
        if (!Object.keys(categories).length) {
            const items = collectArticles(html, pageUrl, MAX_ITEMS);
            if (items.length) categories.Terbaru = items;
        }
        return categories;
    }

    function searchUrl(query) {
        return BASE() + "/?s=" + encodeURIComponent(query)
            + "&post_type%5B%5D=post&post_type%5B%5D=tv";
    }

    function episodeFromLink(link, pageUrl) {
        const url = absoluteUrl(attr(link, "href"), pageUrl);
        if (!url || !/\/eps\//i.test(new URL(url).pathname)) return null;
        const path = new URL(url).pathname;
        const parsed = path.match(/season-(\d+)-episode-(\d+)/i);
        const label = textOf(link);
        const season = Number(parsed && parsed[1]) || Number((label.match(/\bS(?:eason)?\s*(\d+)/i) || [])[1]) || 1;
        const episode = Number(parsed && parsed[2]) || Number((label.match(/(?:Eps?|Episode)\s*(\d+)/i) || [])[1]);
        if (!episode) return null;
        const nameMatch = label.match(/\bS\d+\s*Eps?\s*\d+\b/i);
        return new Episode({
            name: nameMatch ? nameMatch[0].replace(/\s+/g, " ") : label || "Episode " + episode,
            url,
            season,
            episode,
            dubStatus: "sub",
            headers: REFERER_HEADERS()
        });
    }

    function detailItem(html, pageUrl) {
        const titleTag = html.match(/<h1\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
            || html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
        const title = textOf(titleTag && titleTag[1]) || textOf(metaContent(html, "og:title")) || "Dutamovie21";
        const posterTag = html.match(/<div\b[^>]*class=["'][^"']*gmr-movie-data[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*>/i);
        const posterUrl = absoluteUrl(metaContent(html, "og:image")
            || attr(posterTag && posterTag[0], "data-src")
            || attr(posterTag && posterTag[0], "data-lazy-src")
            || attr(posterTag && posterTag[0], "src"), pageUrl);
        const descriptionBlock = html.match(/<div\b[^>]*class=["'][^"']*entry-content-single[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        const description = textOf(descriptionBlock && descriptionBlock[1]) || metaContent(html, "description") || metaContent(html, "og:description");
        const type = itemType(pageUrl, html);
        const list = html.match(/<div\b[^>]*class=["'][^"']*gmr-listseries[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        const linkTags = list ? (list[1].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []) : [];
        const episodes = [];
        const seen = new Set();
        for (const link of linkTags) {
            const episode = episodeFromLink(link, pageUrl);
            if (!episode || seen.has(episode.url)) continue;
            seen.add(episode.url);
            episodes.push(episode);
        }
        episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const item = new MultimediaItem({
            title,
            url: pageUrl,
            posterUrl: posterUrl || "",
            type: episodes.length ? "series" : type,
            year: yearMatch ? Number(yearMatch[0]) : undefined,
            score: scoreFrom(html),
            description: description || undefined,
            tags: [],
            headers: REFERER_HEADERS(),
            episodes: episodes.length ? episodes : type === "series" ? [new Episode({
                name: title,
                url: pageUrl,
                season: 1,
                episode: 1,
                headers: REFERER_HEADERS()
            })] : undefined
        });
        return item;
    }

    function playerRegion(html) {
        const match = String(html || "").match(/<div\b[^>]*class=["'][^"']*gmr-server-wrap[^"']*["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*(?:entry-content|idmuvi-banner)|$)/i);
        return match ? match[0] : String(html || "");
    }

    function streamCandidates(html, pageUrl) {
        const region = playerRegion(html);
        const candidates = [];
        const seen = new Set();
        const tags = region.match(/<(?:iframe|video|source|a|div|button)\b[^>]*>/gi) || [];
        for (const tag of tags) {
            const values = ["src", "data-src", "data-lazy-src", "data-url", "data-embed", "href"]
                .map(name => attr(tag, name)).filter(Boolean);
            for (const value of values) {
                const url = absoluteUrl(value, pageUrl);
                if (!url || seen.has(url) || /youtube\.com\/embed\/(?:x|$)/i.test(url)) continue;
                const parsed = new URL(url);
                if (/\.(?:m3u8|mp4|mpd)(?:$|\?)/i.test(parsed.href)) {
                    seen.add(url);
                    candidates.push({ url, source: /\.m3u8(?:$|\?)/i.test(url) ? "HLS" : "Dutamovie" });
                }
            }
        }
        const mediaLinks = region.match(/https?:\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd)(?:\?[^\s"'<>\\]*)?/gi) || [];
        for (const value of mediaLinks) {
            const url = absoluteUrl(value.replace(/\\\//g, "/"), pageUrl);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            candidates.push({ url, source: /\.m3u8(?:$|\?)/i.test(url) ? "HLS" : "Dutamovie" });
        }
        return candidates;
    }

    function playerPageUrls(html, pageUrl) {
        const nav = String(html || "").match(/<ul\b[^>]*class=["'][^"']*muvipro-player-tabs[^"']*["'][^>]*>[\s\S]*?<\/ul>/i);
        const urls = [pageUrl];
        const links = nav ? (nav[0].match(/<a\b[^>]*>/gi) || []) : [];
        for (const link of links) {
            const url = absoluteUrl(attr(link, "href"), pageUrl);
            if (url && !urls.includes(url)) urls.push(url);
        }
        return urls;
    }

    function iframeUrls(html, pageUrl) {
        const region = playerRegion(html);
        return (region.match(/<iframe\b[^>]*>/gi) || []).map(tag => absoluteUrl(attr(tag, "src"), pageUrl)).filter(Boolean);
    }

    function responseJson(response) {
        const body = response && response.body;
        if (body && typeof body === "object") return body;
        try { return JSON.parse(String(body || "{}")); }
        catch (_) { return {}; }
    }

    function toBytes(value) {
        const bytes = [];
        for (let i = 0; i < String(value).length; i++) bytes.push(String(value).charCodeAt(i) & 255);
        return bytes;
    }

    function fromBytes(bytes) {
        let value = "";
        for (let i = 0; i < bytes.length; i++) value += String.fromCharCode(bytes[i]);
        return value;
    }

    function md5Bytes(value) {
        const bytes = toBytes(value);
        const bitLength = bytes.length * 8;
        bytes.push(0x80);
        while (bytes.length % 64 !== 56) bytes.push(0);
        for (let i = 0; i < 4; i++) bytes.push((bitLength >>> (i * 8)) & 255);
        const highBits = Math.floor(bitLength / 0x100000000);
        for (let i = 0; i < 4; i++) bytes.push((highBits >>> (i * 8)) & 255);

        const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        const constants = new Array(64);
        for (let i = 0; i < 64; i++) constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
        const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
        const rotateLeft = (value, count) => (value << count) | (value >>> (32 - count));

        for (let offset = 0; offset < bytes.length; offset += 64) {
            const words = new Array(16);
            for (let i = 0; i < 16; i++) {
                const p = offset + i * 4;
                words[i] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
            }
            let a = state[0], b = state[1], c = state[2], d = state[3];
            for (let i = 0; i < 64; i++) {
                let f, g, shift;
                if (i < 16) { f = (b & c) | (~b & d); g = i; shift = shifts[i % 4]; }
                else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; shift = shifts[4 + (i % 4)]; }
                else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; shift = shifts[8 + (i % 4)]; }
                else { f = c ^ (b | ~d); g = (7 * i) % 16; shift = shifts[12 + (i % 4)]; }
                const sum = (a + f + constants[i] + words[g]) >>> 0;
                const rotated = rotateLeft(sum, shift) >>> 0;
                const nextB = (b + rotated) >>> 0;
                a = d; d = c; c = b; b = nextB;
            }
            state[0] = (state[0] + a) >>> 0;
            state[1] = (state[1] + b) >>> 0;
            state[2] = (state[2] + c) >>> 0;
            state[3] = (state[3] + d) >>> 0;
        }

        let hex = "";
        for (const word of state) for (let i = 0; i < 4; i++) hex += ((word >>> (i * 8)) & 255).toString(16).padStart(2, "0");
        return hex;
    }

    function aesSbox() {
        const box = new Array(256);
        const mul = (a, b) => {
            let out = 0;
            while (b) {
                if (b & 1) out ^= a;
                a = (a << 1) ^ ((a & 128) ? 0x11b : 0);
                b >>>= 1;
            }
            return out & 255;
        };
        const rot = (x, n) => ((x << n) | (x >>> (8 - n))) & 255;
        for (let i = 0; i < 256; i++) {
            let inv = 0;
            if (i) {
                inv = 1;
                for (let p = 0; p < 254; p++) inv = mul(inv, i);
            }
            box[i] = (inv ^ rot(inv, 1) ^ rot(inv, 2) ^ rot(inv, 3) ^ rot(inv, 4) ^ 0x63) & 255;
        }
        return box;
    }

    function aesCtr(input, keyText, ivText) {
        const sbox = aesSbox();
        const key = toBytes(keyText);
        const nk = key.length / 4;
        if (nk !== 8) throw new Error("Hydrax AES key tidak valid");
        const rounds = nk + 6;
        const expanded = key.slice();
        const xtime = x => ((x << 1) ^ ((x & 128) ? 0x11b : 0)) & 255;
        let rcon = 1;
        while (expanded.length < 16 * (rounds + 1)) {
            let t = expanded.slice(expanded.length - 4);
            if (expanded.length % (nk * 4) === 0) {
                t = [sbox[t[1]] ^ rcon, sbox[t[2]], sbox[t[3]], sbox[t[0]]];
                rcon = xtime(rcon);
            } else if (expanded.length % (nk * 4) === 16) {
                t = t.map(v => sbox[v]);
            }
            for (let i = 0; i < 4; i++) expanded.push(expanded[expanded.length - nk * 4] ^ t[i]);
        }
        function encryptBlock(block) {
            const state = block.slice();
            const addKey = round => { for (let i = 0; i < 16; i++) state[i] ^= expanded[round * 16 + i]; };
            const subShift = () => {
                const s = state.map(v => sbox[v]);
                for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) state[row + col * 4] = s[row + ((col + row) % 4) * 4];
            };
            const mix = () => {
                for (let col = 0; col < 4; col++) {
                    const i = col * 4, a = state[i], b = state[i + 1], c = state[i + 2], d = state[i + 3], all = a ^ b ^ c ^ d;
                    state[i] ^= all ^ xtime(a ^ b); state[i + 1] ^= all ^ xtime(b ^ c);
                    state[i + 2] ^= all ^ xtime(c ^ d); state[i + 3] ^= all ^ xtime(d ^ a);
                }
            };
            addKey(0);
            for (let round = 1; round < rounds; round++) { subShift(); mix(); addKey(round); }
            subShift(); addKey(rounds);
            return state;
        }
        const counter = toBytes(ivText).slice(0, 16);
        while (counter.length < 16) counter.push(0);
        const data = toBytes(input), output = [];
        for (let offset = 0; offset < data.length; offset += 16) {
            const mask = encryptBlock(counter);
            for (let i = 0; i < 16 && offset + i < data.length; i++) output[offset + i] = data[offset + i] ^ mask[i];
            for (let i = 15; i >= 0; i--) { counter[i] = (counter[i] + 1) & 255; if (counter[i]) break; }
        }
        return fromBytes(output);
    }

    function md5Digits(number) {
        const digits = String(number);
        let bytes = "";
        for (let i = 0; i < digits.length; i++) bytes += String.fromCharCode(Number(digits.charAt(i)));
        return md5Bytes(bytes);
    }

    function encodeBase64Binary(value) {
        return btoa(value);
    }

    async function resolveHydraxStreams(embedUrl, referer) {
        let abyssUrl = String(embedUrl || "");
        let current;
        try { current = new URL(abyssUrl); } catch (_) { return []; }

        if (/^(?:www\.)?videonode\.de$/i.test(current.hostname) && /^\/iframe3\/hydrax\//i.test(current.pathname)) {
            const pathMatch = current.pathname.match(/^\/iframe3\/([^/]+)\/(.+)$/i);
            if (!pathMatch) return [];
            const apiResponse = await http_post(current.origin + "/api.php", {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: current.origin,
                Referer: current.href
            }, "host=" + encodeURIComponent(pathMatch[1]) + "&id=" + encodeURIComponent(pathMatch[2]));
            abyssUrl = String(responseJson(apiResponse).embedUrl || "");
        }

        if (!/^https?:\/\/[^/]*abyssplayer\.com\//i.test(abyssUrl)) return [];
        const abyssResponse = await http_get(abyssUrl, { Referer: referer || BASE() + "/" });
        const status = Number(abyssResponse && (abyssResponse.status || abyssResponse.statusCode));
        if (!abyssResponse || status < 200 || status >= 400) return [];
        const html = responseBody(abyssResponse);
        const dataMatch = html.match(/\bconst\s+datas\s*=\s*["']([A-Za-z0-9+/=]+)["']/);
        if (!dataMatch) return [];

        try {
            const packed = JSON.parse(atob(dataMatch[1]));
            const digest = md5Bytes(String(packed.user_id) + ":" + String(packed.slug || packed.v) + ":" + String(packed.md5_id));
            const media = JSON.parse(aesCtr(String(packed.media || ""), digest, digest.slice(0, 16)));
            const mp4 = media && media.mp4;
            const sources = Array.isArray(mp4 && mp4.sources) ? mp4.sources : [];
            const domains = Array.isArray(mp4 && mp4.domains) ? mp4.domains : [];
            const md5Id = String(packed.md5_id || "");
            const slug = String(packed.slug || packed.v || "");
            const streams = [];

            for (const source of sources) {
                if (!source || source.status === false || !source.size || !source.res_id || !source.sub) continue;
                const domain = domains.find(host => String(host).toLowerCase().startsWith(String(source.sub).toLowerCase()))
                    || String(source.sub) + ".sssrr.org";
                const plain = "/mp4/" + md5Id + "/" + source.res_id + "/" + source.size + "?v=" + slug;
                const key = md5Digits(source.size);
                const encrypted = aesCtr(plain, key, key.slice(0, 16));
                const token = encodeBase64Binary(encodeBase64Binary(encrypted).replace(/=/g, "")).replace(/=/g, "");
                streams.push({
                    url: "https://" + domain + "/sora/" + source.size + "/" + token,
                    quality: String(source.label || (Number(source.res_id) * 240) + "p"),
                    referer: "https://abyssplayer.com/"
                });
            }
            return streams;
        } catch (_) {
            return [];
        }
    }

    function mediaLinks(markup, pageUrl) {
        const matches = String(markup || "").match(/(?:https?:)?\\?\/\\?\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd|webm)(?:\?[^\s"'<>\\]*)?/gi) || [];
        const links = [];
        for (const value of matches) {
            const url = absoluteUrl(value.replace(/\\\//g, "/"), pageUrl);
            if (url && !links.includes(url)) links.push(url);
        }
        return links;
    }

    function unpackPlayerScript(markup) {
        const source = String(markup || "");
        const start = source.indexOf("eval(function(p,a,c,k,e,d)");
        if (start < 0) return source;
        const argsStart = source.indexOf("}(", start);
        if (argsStart < 0) return source;
        let index = argsStart + 2;
        const skipSpace = () => { while (/\s/.test(source[index] || "")) index++; };
        const readString = () => {
            skipSpace();
            const quote = source[index++];
            if (quote !== "'" && quote !== '"') return "";
            let value = "";
            while (index < source.length) {
                const char = source[index++];
                if (char === quote) break;
                if (char !== "\\") { value += char; continue; }
                const escaped = source[index++];
                if (escaped === "n") value += "\n";
                else if (escaped === "r") value += "\r";
                else if (escaped === "t") value += "\t";
                else if (escaped === "x") { value += String.fromCharCode(parseInt(source.slice(index, index + 2), 16)); index += 2; }
                else if (escaped === "u") { value += String.fromCharCode(parseInt(source.slice(index, index + 4), 16)); index += 4; }
                else value += escaped;
            }
            return value;
        };
        const readNumber = () => {
            skipSpace();
            const match = source.slice(index).match(/^\d+/);
            if (!match) return 0;
            index += match[0].length;
            return Number(match[0]);
        };
        const payload = readString();
        skipSpace(); if (source[index++] !== ",") return source;
        const radix = readNumber();
        skipSpace(); if (source[index++] !== ",") return source;
        const count = readNumber();
        skipSpace(); if (source[index++] !== ",") return source;
        const keywords = readString().split("|");
        if (radix < 2 || radix > 62 || count < 1 || !keywords.length) return source;
        let unpacked = payload;
        for (let code = count - 1; code >= 0; code--) {
            const word = keywords[code];
            if (!word) continue;
            const token = code.toString(radix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            unpacked = unpacked.replace(new RegExp("\\b" + token + "\\b", "g"), word);
        }
        return unpacked;
    }

    async function getHome(cb) {
        try {
            const page = await requestPage(BASE() + "/");
            cb({ success: true, data: homeCategories(page.html, page.url) });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const term = String(query || "").trim();
            if (!term) { cb({ success: true, data: [] }); return; }
            const page = await requestPage(searchUrl(term));
            cb({ success: true, data: collectArticles(page.html, page.url, MAX_ITEMS) });
        } catch (e) {
            cb({ success: false, error: e && e.message ? e.message : String(e) });
        }
    }

    async function load(url, cb) {
        try {
            const page = await requestPage(url);
            cb({ success: true, data: detailItem(page.html, page.url) });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e) });
        }
    }

    async function loadStreams(url, cb) {
        try {
            const page = await requestPage(url);
            const candidates = streamCandidates(page.html, page.url);
            const seen = new Set(candidates.map(candidate => candidate.url));
            const voe = new Voe();

            // The active server is not always directly playable. Try the site's alternate
            // player tabs and resolve Voe embeds into their HLS URL.
            for (const playerUrl of playerPageUrls(page.html, page.url)) {
                let playerPage = page;
                if (playerUrl !== page.url) {
                    try { playerPage = await requestPage(playerUrl); } catch (_) { continue; }
                }
                for (const embedUrl of iframeUrls(playerPage.html, playerPage.url)) {
                    if (/abyssplayer\.com\//i.test(embedUrl)
                        || (/^(?:www\.)?videonode\.de$/i.test(new URL(embedUrl).hostname) && /\/iframe3\/hydrax\//i.test(new URL(embedUrl).pathname))) {
                        try {
                            const hydrax = await resolveHydraxStreams(embedUrl, playerPage.url);
                            for (const stream of hydrax) {
                                if (!stream.url || seen.has(stream.url)) continue;
                                seen.add(stream.url);
                                candidates.push({
                                    url: stream.url,
                                    source: "Abyss / Hydrax",
                                    quality: stream.quality,
                                    headers: { Referer: stream.referer }
                                });
                            }
                        } catch (_) {}
                        continue;
                    }
                    if (/\.(?:m3u8|mp4|mpd)(?:$|\?)/i.test(embedUrl)) {
                        if (!seen.has(embedUrl)) {
                            seen.add(embedUrl);
                            candidates.push({ url: embedUrl, source: "Dutamovie" });
                        }
                        continue;
                    }
                    if (/\bvoe\.(?:sx|to)\//i.test(embedUrl)) {
                        try {
                            const links = await voe.getUrl(embedUrl, playerPage.url);
                            for (const link of links || []) {
                                if (!link.url || seen.has(link.url)) continue;
                                seen.add(link.url);
                                candidates.push({ url: link.url, source: link.source || link.name || "Voe", headers: link.headers });
                            }
                        } catch (_) {}
                    }

                    // Morencius embeds ship their source list in a Dean Edwards packed
                    // player script. Unpack it and keep only direct media URLs.
                    if (/morencius\./i.test(embedUrl)) {
                        try {
                            const response = await http_get(embedUrl, { Referer: playerPage.url });
                            let body = responseBody(response);
                            if (/eval\s*\(\s*function\s*\(\s*p\s*,/i.test(body)) body = unpackPlayerScript(body);
                            const extracted = mediaLinks(body, embedUrl);
                            for (const mediaUrl of extracted) {
                                if (seen.has(mediaUrl)) continue;
                                seen.add(mediaUrl);
                                candidates.push({ url: mediaUrl, source: "Morencius", headers: { Referer: embedUrl } });
                            }
                        } catch (_) {}
                    }
                }
            }

            const streams = candidates.map(candidate => new StreamResult({
                url: candidate.url,
                source: candidate.source,
                quality: candidate.quality || (/\.m3u8(?:$|\?)/i.test(candidate.url) ? "Auto" : undefined),
                headers: candidate.headers || { Referer: page.url }
            }));
            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
