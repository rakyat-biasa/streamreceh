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
        const response = await http_get(url, REFERER_HEADERS());
        const status = Number(response && (response.status || response.statusCode));
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
            episodes: episodeLinks
        });
        return item;
    }

    async function getHome(cb) {
        try {
            const page = await requestPage(BASE() + "/");
            const html = page.html;
            const featuredMatch = html.match(/<ul\b[^>]*id=["']featured-slider["'][^>]*>([\s\S]*?)<\/ul>/i);
            const trending = collectArticles(featuredMatch ? featuredMatch[1] : html, page.url, 20);
            const latest = collectArticles(html, page.url, 40);
            cb({ success: true, data: { "Trending": trending, "Film & Series Terbaru": latest } });
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

            const response = await http_get(endpoint.href, REFERER_HEADERS());
            const status = Number(response && (response.status || response.statusCode));
            if (!response || status < 200 || status >= 400) {
                throw new Error("LK21 search mengembalikan HTTP " + (status || "tidak diketahui"));
            }
            const result = JSON.parse(String(response.body || "{}"));
            const items = Array.isArray(result.data) ? result.data : [];
            const data = items.map((entry) => {
                const slug = String(entry.slug || "").replace(/^\/+|\/+$/g, "");
                if (!slug || !entry.title) return null;
                const poster = entry.poster
                    ? absoluteUrl(entry.poster, "https://poster.assetsy.de/wp-content/uploads/")
                    : "https://assets.assetsy.de/images/logo-layarkaca21.jpg";
                const type = String(entry.type || "").toLowerCase();
                return new MultimediaItem({
                    title: textOf(entry.title),
                    url: BASE() + "/" + slug,
                    posterUrl: poster,
                    type: type === "series" ? "series" : type === "anime" ? "anime" : "movie",
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

    async function loadStreams(url, cb) {
        try {
            const page = await requestPage(url);
            const results = [];
            const seen = new Set();
            const player = page.html.match(/<iframe\b[^>]*\bid=["']main-player["'][^>]*>/i);
            const primary = player && absoluteUrl(attr(player[0], "src"), page.url);
            if (primary) {
                seen.add(primary);
                results.push(new StreamResult({ url: primary, source: "Player utama", headers: { Referer: page.url } }));
            }
            const servers = page.html.match(/<[^>]+\bdata-url=["'][^"']+["'][^>]*>/gi) || [];
            for (const server of servers) {
                const embed = absoluteUrl(attr(server, "data-url"), page.url);
                if (!embed || seen.has(embed)) continue;
                const name = attr(server, "data-server") || "Server " + (results.length + 1);
                seen.add(embed);
                results.push(new StreamResult({ url: embed, source: name, headers: { Referer: page.url } }));
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
