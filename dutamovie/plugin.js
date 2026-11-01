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
        return absoluteUrl(attr(image, "data-src") || attr(image, "data-lazy-src") || attr(image, "src") || attr(image, "data-original"), pageUrl);
    }

    function scoreFrom(markup) {
        const match = String(markup || "").match(/class=["'][^"']*gmr-rating-item[^"']*["'][^>]*>([\s\S]*?)<\//i)
            || String(markup || "").match(/itemprop=["']ratingValue["'][^>]*content=["']([\d.]+)/i)
            || String(markup || "").match(/itemprop=["']ratingValue["'][^>]*>\s*([\d.]+)/i);
        const value = Number(textOf(match && match[1]));
        return Number.isFinite(value) && value > 0 ? value : undefined;
    }

    function itemType(url, markup) {
        return /\/tv\//i.test(url) || /\/eps\//i.test(url) || /TV Show|Serial TV/i.test(markup) ? "series" : "movie";
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

    function homeCategories(html, pageUrl) {
        const articles = [...String(html || "").matchAll(/<article\b[\s\S]*?<\/article>/gi)];
        const headings = [...String(html || "").matchAll(/<h[23]\b([^>]*)>([\s\S]*?)<\/h[23]>/gi)]
            .filter(match => !/entry-title/i.test(attr("<h2 " + match[1] + ">", "class")))
            .map(match => ({ index: match.index, title: textOf(match[2]) }))
            .filter(entry => entry.title && entry.title.length < 60);
        const groups = {};
        const seen = new Set();
        for (const match of articles) {
            const item = articleItem(match[0], pageUrl);
            if (!item || seen.has(item.url)) continue;
            seen.add(item.url);
            let category = "Terbaru";
            for (const heading of headings) {
                if (heading.index > match.index) break;
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
        const posterUrl = absoluteUrl(attr(posterTag && posterTag[0], "src") || metaContent(html, "og:image"), pageUrl);
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
            episodes: episodes.length ? episodes : [new Episode({
                name: title,
                url: pageUrl,
                season: 1,
                episode: 1,
                headers: REFERER_HEADERS()
            })]
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
            const streams = streamCandidates(page.html, page.url).map(candidate => new StreamResult({
                url: candidate.url,
                source: candidate.source,
                quality: /\.m3u8(?:$|\?)/i.test(candidate.url) ? "Auto" : undefined,
                headers: { Referer: page.url }
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
