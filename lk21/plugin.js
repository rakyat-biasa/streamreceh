(function () {
    const BASE = () => String(manifest.baseUrl || "https://tv12.lk21official.cc").replace(/\/$/, "");
    const REFERER_HEADERS = () => ({ Referer: BASE() + "/" });

    function decodeHtml(value) {
        return String(value || "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#0*39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
            .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
    }

    function textOf(html) {
        return decodeHtml(String(html || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
    }

    function attr(html, name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = String(html || "").match(new RegExp("\\b" + escaped + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
        return match ? decodeHtml(match[2]) : "";
    }

    function absoluteUrl(value, pageUrl) {
        if (!value || value.charAt(0) === "#" || /^javascript:/i.test(value)) return "";
        try {
            const resolved = new URL(value, pageUrl || BASE() + "/");
            if (/^(?:tv\d+\.layanfilem\.my|tv\.nontondrama\.vip|tv\d+\.lk21official\.cc|dramamu\.lk21\.de)$/i.test(resolved.hostname)) {
                const selected = new URL(BASE());
                resolved.protocol = selected.protocol;
                resolved.host = selected.host;
            }
            return resolved.href;
        }
        catch (_) { return ""; }
    }

    function normalizeItemUrl(value, pageUrl) {
        const resolved = absoluteUrl(value, pageUrl);
        if (!resolved) return "";
        try {
            const parsed = new URL(resolved);
            if (/\/nontondrama\/?$/i.test(parsed.pathname) && parsed.searchParams.has("page")) {
                const slug = parsed.searchParams.get("page");
                if (slug && !slug.includes("/")) return BASE() + "/" + encodeURIComponent(slug);
            }
            return resolved;
        } catch (_) { return resolved; }
    }

    async function requestPage(url, redirectDepth) {
        let response;
        let status = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            response = await http_get(url, REFERER_HEADERS());
            status = Number(response && (response.status || response.statusCode));
            if (status < 500 || status >= 600 || attempt === 2) break;
        }
        if (!response || status < 200 || status >= 400) {
            throw new Error("LK21 mengembalikan HTTP " + (status || "tidak diketahui"));
        }
        const html = String(response.body || "");
        const depth = Number(redirectDepth) || 0;
        const openNow = html.match(/<a\b[^>]*\bid=["']openNow["'][^>]*>/i);
        const redirectHref = openNow && attr(openNow[0], "href");
        const nextUrl = redirectHref && (/^https?:\/\//i.test(redirectHref) ? redirectHref : absoluteUrl(redirectHref, url));
        if (nextUrl && nextUrl !== url && depth < 4) return requestPage(nextUrl, depth + 1);
        return { html, url };
    }

    function collectArticles(html, pageUrl, limit) {
        const items = [];
        const seen = new Set();
        const articles = String(html || "").match(/<article\b[\s\S]*?<\/article>/gi) || [];
        for (const article of articles) {
            const linkMatch = article.match(/<a\b[^>]*>/i);
            if (!linkMatch) continue;
            const itemUrl = normalizeItemUrl(attr(linkMatch[0], "href"), pageUrl);
            if (!itemUrl || seen.has(itemUrl)) continue;
            const heading = article.match(/<h[1-4]\b[^>]*class=["'][^"']*poster-title[^"']*["'][^>]*>([\s\S]*?)<\/h[1-4]>/i);
            const image = article.match(/<img\b[^>]*>/i);
            const title = textOf(heading ? heading[1] : attr(image && image[0], "alt") || attr(linkMatch[0], "title"));
            if (!title) continue;
            const imageTag = image ? image[0] : "";
            const poster = absoluteUrl(attr(imageTag, "data-src") || attr(imageTag, "src") || attr(imageTag, "data-lazy-src"), pageUrl);
            const yearMatch = article.match(/class=["'][^"']*\byear\b[^"']*["'][^>]*>([\s\S]*?)<\//i);
            const scoreMatch = article.match(/itemprop=["']ratingValue["'][^>]*>([\d.]+)/i) || article.match(/class=["'][^"']*rating[^"']*["'][^>]*>\s*([\d.]+)/i);
            const isSeries = /nontondrama|series|drama/i.test(itemUrl) || /class=["'][^"']*episode\b/i.test(article);
            const titleYear = title.match(/\((19|20)\d{2}\)/);
            const year = Number(textOf(yearMatch ? yearMatch[1] : "") || (titleYear && titleYear[0].slice(1, -1))) || undefined;
            const score = scoreMatch ? Number(scoreMatch[1]) : undefined;
            const genres = article.match(/<div\b[^>]*class=["'][^"']*genre[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
            const item = new MultimediaItem({
                title,
                url: itemUrl,
                posterUrl: poster || "https://assets.assetsy.de/images/logo-layarkaca21.jpg",
                type: isSeries ? "series" : "movie",
                year,
                score,
                description: genres ? textOf(genres[1]) : undefined,
                headers: REFERER_HEADERS()
            });
            seen.add(itemUrl);
            items.push(item);
            if (items.length >= limit) break;
        }
        return items;
    }

    function collectHomeCategories(html, pageUrl) {
        const categories = {};
        const wrappers = String(html || "").match(/<div\b[^>]*class=["'][^"']*\bslider-wrapper\b[^"']*["'][^>]*>/gi) || [];
        for (const wrapper of wrappers) {
            const label = textOf(attr(wrapper, "aria-label"));
            if (!label) continue;
            const start = String(html).indexOf(wrapper);
            if (start < 0) continue;
            const list = String(html).slice(start + wrapper.length).match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/i);
            if (!list) continue;
            const items = collectArticles(list[1], pageUrl, 40);
            if (!items.length) continue;
            const name = /^film terbaru$/i.test(label) ? "Film & Series Terbaru" : label;
            if (!categories[name]) categories[name] = items;
        }
        return categories;
    }

    function firstMeta(html, property) {
        const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
        const tag = tags.find(value => attr(value, "property").toLowerCase() === property.toLowerCase() || attr(value, "name").toLowerCase() === property.toLowerCase());
        return tag ? attr(tag, "content") : "";
    }

    function detailFrom(html, pageUrl) {
        const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
        const title = textOf(h1 ? h1[1] : firstMeta(html, "og:title")) || "LK21";
        const poster = firstMeta(html, "og:image") || "";
        const description = firstMeta(html, "description") || firstMeta(html, "og:description");
        const scoreMatch = html.match(/data-base-rating=["']([\d.]+)/i) || html.match(/class=["'][^"']*rating-number[^"']*["'][^>]*>([\d.]+)/i);
        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const episodeLinks = [];
        const listMatch = html.match(/<ul\b[^>]*class=["'][^"']*episode-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
        const links = listMatch ? (listMatch[1].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []) : [];
        const currentPath = (pageUrl.match(/^https?:\/\/[^/]+(\/[^?#]*)/i) || [])[1] || "";
        for (const link of links) {
            const episodeUrl = normalizeItemUrl(attr(link, "href"), pageUrl);
            if (!episodeUrl) continue;
            const path = (episodeUrl.match(/^https?:\/\/[^/]+(\/[^?#]*)/i) || [])[1] || "";
            const match = path.match(/season-(\d+)-episode-(\d+)/i);
            const episodeNo = match ? Number(match[2]) : Number(textOf(link));
            const seasonNo = match ? Number(match[1]) : 1;
            if (!episodeNo) continue;
            episodeLinks.push(new Episode({
                name: "Episode " + episodeNo,
                url: episodeUrl,
                season: seasonNo,
                episode: episodeNo,
                dubStatus: "sub",
                headers: REFERER_HEADERS()
            }));
        }
        if (!episodeLinks.length) {
            const seasonScript = html.match(/<script\b[^>]*\bid=["']season-data["'][^>]*>([\s\S]*?)<\/script>/i);
            if (seasonScript) {
                try {
                    const seasons = JSON.parse(seasonScript[1].trim());
                    for (const seasonKey of Object.keys(seasons || {})) {
                        const seasonEpisodes = Array.isArray(seasons[seasonKey]) ? seasons[seasonKey] : [];
                        for (const entry of seasonEpisodes) {
                            const slug = String(entry.slug || "").replace(/^\/+|\/+$/g, "");
                            const episodeNo = Number(entry.episode_no);
                            if (!slug || !episodeNo) continue;
                            episodeLinks.push(new Episode({
                                name: textOf(entry.title) || "Episode " + episodeNo,
                                url: normalizeItemUrl("/" + slug, pageUrl),
                                season: Number(entry.s || seasonKey) || 1,
                                episode: episodeNo,
                                dubStatus: "sub",
                                headers: REFERER_HEADERS()
                            }));
                        }
                    }
                } catch (_) { }
            }
        }
        const type = episodeLinks.length || /data-web_type=["']series/i.test(html) || /\/season-\d+-episode-\d+/i.test(pageUrl) ? "series" : "movie";
        // SkyStream enables the detail-page Play button from a non-empty
        // episodes list, then asks loadStreams for that episode URL. A movie
        // has no real episode list, so use its own page URL as the playable
        // target while keeping the item type as "movie".
        const playableEpisodes = type === "movie" ? [new Episode({
            name: title,
            url: pageUrl,
            season: 1,
            episode: 1,
            headers: REFERER_HEADERS()
        })] : episodeLinks;
        const genres = [];
        const tagList = html.match(/<div\b[^>]*class=["'][^"']*tag-list[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        if (tagList) {
            const tags = tagList[1].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
            for (const tag of tags) genres.push(textOf(tag));
        }
        const item = new MultimediaItem({
            title,
            url: pageUrl,
            posterUrl: poster || "https://assets.assetsy.de/images/logo-layarkaca21.jpg",
            type,
            year: yearMatch ? Number(yearMatch[0]) : undefined,
            score: scoreMatch ? Number(scoreMatch[1]) : undefined,
            description: description || undefined,
            status: type === "series" ? (/ongoing/i.test(html) ? "ongoing" : "completed") : undefined,
            tags: genres,
            headers: REFERER_HEADERS(),
            episodes: playableEpisodes
        });
        return item;
    }

    async function getHome(cb) {
        try {
            const page = await requestPage(BASE() + "/");
            const categories = collectHomeCategories(page.html, page.url);
            if (!Object.keys(categories).length) {
                categories["Film & Series Terbaru"] = collectArticles(page.html, page.url, 40);
            }
            cb({ success: true, data: categories });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: String(e) });
        }
    }

    async function search(query, cb) {
        try {
            const searchTerm = String(query || "").trim();
            if (!searchTerm) {
                cb({ success: true, data: [] });
                return;
            }

            // The visible search page loads its results asynchronously from this JSON endpoint.
            const page = await requestPage(BASE() + "/search?s=" + encodeURIComponent(searchTerm));
            const bodyTag = page.html.match(/<body\b[^>]*>/i);
            const searchBase = attr(bodyTag && bodyTag[0], "data-search_url") || "https://gudangvape.com/";
            const endpoint = new URL("search.php", searchBase.endsWith("/") ? searchBase : searchBase + "/");
            endpoint.searchParams.set("s", searchTerm);
            endpoint.searchParams.set("page", "1");

            const searchPage = new URL(page.url);
            const searchHeaders = {
                Accept: "application/json, text/javascript, */*; q=0.01",
                Origin: searchPage.origin,
                Referer: page.url
            };
            let response;
            let status = 0;
            for (let attempt = 0; attempt < 3; attempt++) {
                response = await http_get(endpoint.href, searchHeaders);
                status = Number(response && (response.status || response.statusCode));
                if (status < 500 || status >= 600 || attempt === 2) break;
            }
            if (!response || status < 200 || status >= 400) {
                throw new Error("LK21 search mengembalikan HTTP " + (status || "tidak diketahui"));
            }
            const result = responseJson(response);
            const items = Array.isArray(result.data) ? result.data : Array.isArray(result.items) ? result.items : [];
            if (!items.length && (result.error || result.status === "error")) {
                throw new Error(String(result.error || result.message || "LK21 gagal memproses pencarian"));
            }
            const data = items.map((entry) => {
                const slug = String(entry.slug || "").replace(/^\/+|\/+$/g, "");
                if (!slug || !entry.title) return null;
                const poster = entry.poster
                    ? absoluteUrl(entry.poster, "https://poster.assetsy.de/wp-content/uploads/")
                    : "https://assets.assetsy.de/images/logo-layarkaca21.jpg";
                const type = String(entry.type || "").toLowerCase();
                const contentType = type === "series" ? "series" : type === "anime" ? "anime" : "movie";
                return new MultimediaItem({
                    title: textOf(entry.title),
                    url: BASE() + "/" + slug,
                    posterUrl: poster,
                    type: contentType,
                    contentType,
                    year: Number(entry.year) || undefined,
                    score: Number(entry.rating) || undefined,
                    headers: REFERER_HEADERS()
                });
            }).filter(Boolean);
            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: String(e) });
        }
    }

    async function load(url, cb) {
        try {
            const page = await requestPage(normalizeItemUrl(url, BASE() + "/"));
            cb({ success: true, data: detailFrom(page.html, page.url) });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: String(e) });
        }
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

    function formatSourceName(provider, quality) {
        const label = String(quality || "").trim();
        const resolution = label.match(/\b(\d{3,4})p\b/i);
        const pixels = resolution ? Number(resolution[1]) : 0;
        const tier = pixels >= 2160 ? "4K HD" : pixels >= 1080 ? "Full HD" : pixels >= 720 ? "HD" : pixels >= 480 ? "SD" : "";
        return (tier ? tier + " " : "") + "[" + String(provider || "Stream").trim() + "]" + (label ? " [" + label + "]" : "");
    }

    async function resolveHydraxStreams(embedUrl) {
        let current;
        try { current = new URL(embedUrl); } catch (_) { return []; }
        const apiHeaders = { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(embedUrl).origin, Referer: embedUrl };
        const pathMatch = current.pathname.match(/^\/iframe3\/([^/]+)\/(.+)$/i);
        if (!pathMatch) return [];
        const apiResponse = await http_post(current.origin + "/api.php", apiHeaders, "host=" + encodeURIComponent(pathMatch[1]) + "&id=" + encodeURIComponent(pathMatch[2]));
        const payload = responseJson(apiResponse);
        const abyssUrl = String(payload.embedUrl || "");
        if (!/^https?:\/\/[^/]*abyssplayer\.com\//i.test(abyssUrl)) return [];
        const abyssResponse = await http_get(abyssUrl, { Referer: embedUrl });
        const abyssStatus = Number(abyssResponse && (abyssResponse.status || abyssResponse.statusCode));
        if (!abyssResponse || abyssStatus < 200 || abyssStatus >= 400) return [];
        const html = String(abyssResponse.body || "");
        const dataMatch = html.match(/\bconst\s+datas\s*=\s*["']([A-Za-z0-9+/=]+)["']/);
        if (!dataMatch) return [];
        const packed = JSON.parse(atob(dataMatch[1]));
        const digest = md5Bytes(String(packed.user_id) + ":" + String(packed.slug || packed.v) + ":" + String(packed.md5_id));
        const decrypted = aesCtr(String(packed.media || ""), digest, digest.slice(0, 16));
        const media = JSON.parse(decrypted);
        const mp4 = media && media.mp4;
        const sources = Array.isArray(mp4 && mp4.sources) ? mp4.sources : [];
        const domains = Array.isArray(mp4 && mp4.domains) ? mp4.domains : [];
        const md5Id = String(packed.md5_id || "");
        const slug = String(packed.slug || packed.v || "");
        const streams = [];
        for (const source of sources) {
            if (!source || source.status === false || !source.size || !source.res_id || !source.sub) continue;
            const domain = domains.find(host => String(host).toLowerCase().startsWith(String(source.sub).toLowerCase())) || String(source.sub) + ".sssrr.org";
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
    }

    async function resolveStreamUrl(embedUrl) {
        let current;
        try { current = new URL(embedUrl); }
        catch (_) { return null; }

        if (/^(?:www\.)?videonode\.de$/i.test(current.hostname) && /^\/iframe3\//i.test(current.pathname)) {
            const parts = current.pathname.split("/").filter(Boolean);
            if (parts.length < 3) return null;
            const host = parts[1];
            const id = parts.slice(2).join("/");
            const apiUrl = current.origin + "/api.php";
            const response = await http_post(apiUrl, {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: current.origin,
                Referer: current.href
            }, "host=" + encodeURIComponent(host) + "&id=" + encodeURIComponent(id));
            const status = Number(response && (response.status || response.statusCode));
            if (!response || status < 200 || status >= 400) return null;
            const payload = responseJson(response);
            if (!payload.embedUrl) return null;
            try { current = new URL(payload.embedUrl, current.href); }
            catch (_) { return null; }
        }

        if (/^(?:www\.)?playcdn\.de$/i.test(current.hostname)) {
            const slug = current.pathname.split("/").filter(Boolean).pop();
            if (!slug) return null;
            const verifyUrl = current.origin + "/verify/" + encodeURIComponent(slug);
            const response = await http_get(verifyUrl, { Referer: current.href, Origin: current.origin });
            const status = Number(response && (response.status || response.statusCode));
            if (!response || status < 200 || status >= 400) return null;
            const payload = responseJson(response);
            const mediaUrl = String(payload.fileUrl || "");
            if (!/^https?:\/\//i.test(mediaUrl) || !/\.(?:m3u8|mp4|mpd)(?:$|\?)/i.test(mediaUrl)) return null;
            return { url: mediaUrl, referer: current.href, title: payload.title || "" };
        }

        if (/\.(?:m3u8|mp4|mpd)(?:$|\?)/i.test(current.href)) {
            return { url: current.href, referer: current.origin + "/" };
        }
        return null;
    }

    async function loadStreams(url, cb) {
        try {
            const page = await requestPage(url);
            const results = [];
            const seen = new Set();
            const player = page.html.match(/<iframe\b[^>]*\bid=["']main-player["'][^>]*>/i);
            const primary = player && absoluteUrl(attr(player[0], "src"), page.url);
            const candidates = [];
            if (primary) candidates.push({ url: primary, source: "Player utama" });
            const servers = page.html.match(/<[^>]+\bdata-url=["'][^"']+["'][^>]*>/gi) || [];
            for (const server of servers) {
                const embed = absoluteUrl(attr(server, "data-url"), page.url);
                if (!embed || candidates.some(candidate => candidate.url === embed)) continue;
                candidates.push({ url: embed, source: attr(server, "data-server") || "Server " + (candidates.length + 1) });
            }
            for (const candidate of candidates) {
                try {
                    if (/^(?:www\.)?videonode\.de$/i.test(new URL(candidate.url).hostname) && /\/iframe3\/hydrax\//i.test(new URL(candidate.url).pathname)) {
                        const hydrax = await resolveHydraxStreams(candidate.url);
                        for (const stream of hydrax) {
                            if (!stream.url || seen.has(stream.url)) continue;
                            seen.add(stream.url);
                            results.push(new StreamResult({
                                url: stream.url,
                                source: formatSourceName("Hydrax", stream.quality),
                                quality: stream.quality,
                                headers: { Referer: stream.referer }
                            }));
                        }
                        continue;
                    }
                    const stream = await resolveStreamUrl(candidate.url);
                    if (!stream || seen.has(stream.url)) continue;
                    seen.add(stream.url);
                    const quality = /\.m3u8(?:$|\?)/i.test(stream.url) ? "Auto" : undefined;
                    results.push(new StreamResult({
                        url: stream.url,
                        source: formatSourceName(candidate.source, quality) + (stream.title ? " [" + stream.title + "]" : ""),
                        quality,
                        headers: { Referer: stream.referer || page.url }
                    }));
                } catch (_) { }
            }
            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: "STREAM_ERROR", message: String(e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
