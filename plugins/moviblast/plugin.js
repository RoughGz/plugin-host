(function () {
	const BASE_URL = atob("aHR0cHM6Ly9hcHAuY2xvdWQtbWIueHl6");
	const TOKEN = atob("amR2aGhqdjI1NXZnaGhnZGh2ZmNoMjU2NTY1NmpoZGNnaGZkZg==");
	const HMAC_SECRET = atob(
		"R0o4cmV5ZGFySTdKcWF0OXJ2YkFKS05ROWdZNERvRVFGMkg1bmZ1STFnaQ==",
	);
	const MAX_RETRIES = 2;
	const TIMEOUT_MS = 5000;
	const MAX_PAGES = 5;
	const MAX_ITEMS = 100;

	const COMMON_HEADERS = {
		"User-Agent": "okhttp/5.0.0-alpha.6",
	};

	const PLAYBACK_HEADERS = {
		"Accept-Encoding": "identity",
		Connection: "Keep-Alive",
		"Icy-MetaData": "1",
		Referer: "MovieBlast",
		"User-Agent": "MovieBlast",
		"x-request-x": atob("Y29tLm1vdmllYmxhc3QNCg==").trim(),
	};

	const PLAYBACK_HEADERS_TV = {
		"Accept-Encoding": "identity",
		Connection: "Keep-Alive",
		Referer: "MovieBlast",
		"User-Agent": "MovieBlast",
		"x-request-x": atob("Y29tLm1vdmllYmxhc3QNCg==").trim(),
	};

	const HOME_SECTIONS = [
		{ name: "Trending", path: "api/genres/trending/all/" + TOKEN },
		{ name: "Latest", path: "api/genres/pinned/all/" + TOKEN },
		{ name: "Recently Added", path: "api/genres/new/all/" + TOKEN },
		{
			name: "Popular \u2022 Movies",
			path: "api/genres/popularmovies/all/" + TOKEN,
		},
		{
			name: "Popular \u2022 Series",
			path: "api/genres/popularseries/all/" + TOKEN,
		},
		{
			name: "Latest \u2022 Series",
			path: "api/media/seriesEpisodesAll/" + TOKEN,
		},
		{ name: "Recommended", path: "api/genres/recommended/all/" + TOKEN },
		{
			name: "New HD Releases",
			path: "api/genres/media/names/New%20HD%20Released/" + TOKEN,
		},
	];

	function httpsify(url) {
		if (!url) return "";
		var s = String(url).trim();
		if (!s) return "";
		return s.startsWith("http") ? s : "https://" + s;
	}

	function extractUrlPath(urlStr) {
		try {
			var u = new URL(urlStr);
			return u.pathname || "/";
		} catch (_) {
			var m = urlStr.match(/^https?:\/\/[^/]+(\/[^?#]*)?/);
			return (m && m[1]) || "/";
		}
	}

	function matchQuality(serverLabel, streamUrl) {
		var u = (streamUrl || "").toLowerCase();
		var s = String(serverLabel || "").toLowerCase();
		var text = u + " " + s;
		if (text.includes("2160") || text.includes("4k")) return "4K";
		if (text.includes("1440")) return "1440p";
		if (text.includes("1080") || text.includes("fullhd")) return "1080p";
		if (text.includes("720") || text.includes("hd")) return "720p";
		if (text.includes("480")) return "480p";
		if (text.includes("360")) return "360p";
		var resMatch = u.match(/[_\-.](\d{3,4})p?[_\-.]/);
		if (resMatch) return resMatch[1] + "p";
		return "Auto";
	}

	function createSourceLabel(server, lang, quality, streamUrl) {
		var parts = [];
		if (server) parts.push(server);
		if (lang) parts.push(lang);
		if (quality && quality !== "Auto") parts.push(quality);
		var u = (streamUrl || "").toLowerCase();
		if (u.includes("h265") || u.includes("hevc")) parts.push("HEVC");
		else if (u.includes("h264") || u.includes("avc")) parts.push("H264");
		if (u.includes("hdr") || u.includes("10bit")) parts.push("HDR");
		return parts.join(" \u2022 ") || "MovieBlast";
	}

	function strToUtf8Bytes(str) {
		var bytes = [];
		for (var i = 0; i < str.length; i++) {
			var c = str.charCodeAt(i);
			if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
				var c2 = str.charCodeAt(i + 1);
				if (c2 >= 0xdc00 && c2 <= 0xdfff) {
					c = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
					i++;
				}
			}
			if (c < 0x80) bytes.push(c);
			else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
			else if (c < 0x10000)
				bytes.push(
					0xe0 | (c >> 12),
					0x80 | ((c >> 6) & 0x3f),
					0x80 | (c & 0x3f),
				);
			else
				bytes.push(
					0xf0 | (c >> 18),
					0x80 | ((c >> 12) & 0x3f),
					0x80 | ((c >> 6) & 0x3f),
					0x80 | (c & 0x3f),
				);
		}
		return bytes;
	}

	function bytesToBase64(bytes) {
		var CHARS =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		var out = "";
		for (var i = 0; i < bytes.length; i += 3) {
			var b0 = bytes[i],
				b1 = i + 1 < bytes.length ? bytes[i + 1] : null,
				b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
			out += CHARS[b0 >> 2];
			out += CHARS[((b0 & 3) << 4) | (b1 != null ? b1 >> 4 : 0)];
			if (b1 != null) {
				out += CHARS[((b1 & 0xf) << 2) | (b2 != null ? b2 >> 6 : 0)];
				out += b2 != null ? CHARS[b2 & 0x3f] : "=";
			} else out += "==";
		}
		return out;
	}

	function hexToBytes(hex) {
		var bytes = [];
		for (var i = 0; i < hex.length; i += 2)
			bytes.push(parseInt(hex.substring(i, i + 2), 16));
		return bytes;
	}

	function bytesToHex(bytes) {
		return bytes
			.map(function (b) {
				return b.toString(16).padStart(2, "0");
			})
			.join("");
	}

	var SHA256_K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];

	function safeAdd32(x, y) {
		var lsw = (x & 0xffff) + (y & 0xffff);
		var msw = (x >>> 16) + (y >>> 16) + (lsw >>> 16);
		return ((msw & 0xffff) << 16) | (lsw & 0xffff);
	}

	function rr(x, n) {
		return (x >>> n) | (x << (32 - n));
	}

	function sha256Block(block, H) {
		var W = new Array(64).fill(0);
		for (var t = 0; t < 16; t++)
			W[t] =
				(block[t * 4] << 24) |
				(block[t * 4 + 1] << 16) |
				(block[t * 4 + 2] << 8) |
				block[t * 4 + 3];
		for (t = 16; t < 64; t++)
			W[t] = safeAdd32(
				safeAdd32(
					rr(W[t - 15], 7) ^ rr(W[t - 15], 18) ^ (W[t - 15] >>> 3),
					rr(W[t - 2], 17) ^ rr(W[t - 2], 19) ^ (W[t - 2] >>> 10),
				),
				safeAdd32(W[t - 16], W[t - 7]),
			);
		var a = H[0],
			b = H[1],
			c = H[2],
			d = H[3],
			e = H[4],
			f = H[5],
			g = H[6],
			h = H[7];
		for (t = 0; t < 64; t++) {
			var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
			var ch = (e & f) ^ (~e & g);
			var temp1 = safeAdd32(
				safeAdd32(safeAdd32(safeAdd32(h, S1), ch), SHA256_K[t]),
				W[t],
			);
			var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
			var maj = (a & b) ^ (a & c) ^ (b & c);
			var temp2 = safeAdd32(S0, maj);
			h = g;
			g = f;
			f = e;
			e = safeAdd32(d, temp1);
			d = c;
			c = b;
			b = a;
			a = safeAdd32(temp1, temp2);
		}
		H[0] = safeAdd32(H[0], a);
		H[1] = safeAdd32(H[1], b);
		H[2] = safeAdd32(H[2], c);
		H[3] = safeAdd32(H[3], d);
		H[4] = safeAdd32(H[4], e);
		H[5] = safeAdd32(H[5], f);
		H[6] = safeAdd32(H[6], g);
		H[7] = safeAdd32(H[7], h);
	}

	function sha256BytesFallback(msgBytes) {
		var H = [
			0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
			0x1f83d9ab, 0x5be0cd19,
		];
		var msgLen = msgBytes.length;
		var bitLen = msgLen * 8;
		var padded = [];
		for (var i = 0; i < msgLen; i++) padded.push(msgBytes[i]);
		padded.push(0x80);
		while (padded.length % 64 !== 56) padded.push(0);
		padded.push(0, 0, 0, 0);
		padded.push(
			(bitLen >>> 24) & 0xff,
			(bitLen >>> 16) & 0xff,
			(bitLen >>> 8) & 0xff,
			bitLen & 0xff,
		);
		for (var offset = 0; offset < padded.length; offset += 64)
			sha256Block(padded.slice(offset, offset + 64), H);
		var hash = new Array(32);
		for (i = 0; i < 8; i++) {
			hash[i * 4] = (H[i] >>> 24) & 0xff;
			hash[i * 4 + 1] = (H[i] >>> 16) & 0xff;
			hash[i * 4 + 2] = (H[i] >>> 8) & 0xff;
			hash[i * 4 + 3] = H[i] & 0xff;
		}
		return hash;
	}

	function computeSha256(msgBytes) {
		// CRITICAL: Always use pure-JS SHA-256. The nativeSha256 (when available)
		// interprets String.fromCharCode strings as UTF-8, which corrupts bytes >= 128
		// (common in HMAC inner hash output). This caused all HMAC-signed URLs to fail
		// because the outer hash was computed over UTF-8-encoded bytes instead of raw bytes.
		// Reference: Node crypto HMAC produces identical results to this pure-JS fallback.
		return sha256BytesFallback(msgBytes);
	}

	function hmacSha256(keyStr, msgStr) {
		var BLOCK_SIZE = 64;
		var keyBytes = strToUtf8Bytes(keyStr);
		if (keyBytes.length > BLOCK_SIZE) keyBytes = computeSha256(keyBytes);
		var paddedKey = keyBytes.slice(0);
		while (paddedKey.length < BLOCK_SIZE) paddedKey.push(0);
		var ipad = paddedKey.map(function (b) {
			return b ^ 0x36;
		});
		var opad = paddedKey.map(function (b) {
			return b ^ 0x5c;
		});
		var innerInput = ipad.concat(strToUtf8Bytes(msgStr));
		var innerHash = computeSha256(innerInput);
		var outerInput = opad.concat(innerHash);
		return computeSha256(outerInput);
	}

	function generateSignedUrl(rawUrl) {
		try {
			var url = httpsify(rawUrl);
			if (!url) return "";
			var path = extractUrlPath(url);
			var ts = Math.floor(Date.now() / 1000).toString();
			var sig = hmacSha256(HMAC_SECRET, path + ts);
			var b64 = bytesToBase64(sig);
			var encoded = encodeURIComponent(b64);
			var baseUrl = url.indexOf("?") !== -1 ? url.split("?")[0] : url;
			return baseUrl + "?verify=" + ts + "-" + encoded;
		} catch (_) {
			return httpsify(rawUrl);
		}
	}

	function httpGetWithTimeout(url, headers, timeoutMs) {
		return new Promise(function (resolve, reject) {
			var timedOut = false;
			var timer = setTimeout(function () {
				timedOut = true;
				reject(new Error("timeout"));
			}, timeoutMs);
			http_get(url, { headers: headers })
				.then(function (res) {
					if (!timedOut) {
						clearTimeout(timer);
						resolve(res);
					}
				})
				.catch(function (err) {
					if (!timedOut) {
						clearTimeout(timer);
						reject(err);
					}
				});
		});
	}

	async function apiGet(path, extraHeaders) {
		var url = BASE_URL + "/" + path;
		var merged = {};
		for (var k in COMMON_HEADERS)
			if (Object.prototype.hasOwnProperty.call(COMMON_HEADERS, k))
				merged[k] = COMMON_HEADERS[k];
		if (extraHeaders)
			for (k in extraHeaders)
				if (Object.prototype.hasOwnProperty.call(extraHeaders, k))
					merged[k] = extraHeaders[k];
		var res = await http_get(url, { headers: merged });
		if (!res || !res.body) throw new Error("Empty response from " + url);
		return JSON.parse(res.body);
	}

	function isSeries(raw) {
		var t = String(raw.type || "").toLowerCase();
		var c = String(raw.content_type || "").toLowerCase();
		return (
			["series", "serie", "tv", "show"].indexOf(t) !== -1 || c === "series"
		);
	}

	function itemToMultimedia(raw) {
		if (!raw || !raw.id) return null;
		var title = raw.name || raw.title || "Unknown";
		var series = isSeries(raw);
		var type = series ? "series" : "movie";
		var apiPath = series
			? "api/series/show/" + raw.id + "/" + TOKEN
			: "api/media/detail/" + raw.id + "/" + TOKEN;
		return new MultimediaItem({
			title: title,
			url: BASE_URL + "/" + apiPath,
			posterUrl: raw.poster_path || "",
			type: type,
			year: raw.release_date
				? parseInt(String(raw.release_date).split("-")[0], 10)
				: undefined,
			score:
				raw.vote_average != null ? parseFloat(raw.vote_average) : undefined,
			description: raw.overview || "",
		});
	}

	async function getHome(cb) {
		try {
			var data = {};
			var sectionPromises = HOME_SECTIONS.map(function (section) {
				return (async function () {
					var allItems = [];
					for (var page = 1; page <= MAX_PAGES; page++) {
						try {
							var json = await apiGet(section.path + "?page=" + page);
							var items = (json.data || [])
								.map(itemToMultimedia)
								.filter(function (it) {
									return it !== null;
								});
							if (items.length === 0) break;
							allItems = allItems.concat(items);
						} catch (_) {
							break;
						}
					}
					var seen = {};
					var uniq = [];
					for (var i = 0; i < allItems.length; i++) {
						var it = allItems[i];
						var key = it.url || it.title + "-" + it.posterUrl;
						if (seen[key]) continue;
						seen[key] = true;
						uniq.push(it);
					}
					return { name: section.name, items: uniq.slice(0, MAX_ITEMS) };
				})();
			});
			var results = await Promise.all(sectionPromises);
			for (var i = 0; i < results.length; i++) {
				if (results[i].items.length > 0)
					data[results[i].name] = results[i].items;
			}
			cb({ success: true, data: data });
		} catch (e) {
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: String(e && e.message ? e.message : e),
			});
		}
	}

	async function search(query, cb) {
		try {
			var raw = String(query || "").trim();
			if (!raw) return cb({ success: true, data: [] });
			var safeQuery = encodeURIComponent(raw);
			var res = await http_get(
				BASE_URL + "/api/search/" + safeQuery + "/" + TOKEN,
				{ headers: COMMON_HEADERS },
			);
			if (!res || !res.body) return cb({ success: true, data: [] });
			var json = JSON.parse(res.body);
			var arr = json.search || json.data || (Array.isArray(json) ? json : []);
			if (!Array.isArray(arr)) return cb({ success: true, data: [] });
			var items = arr
				.map(function (item) {
					if (!item || !item.id) return null;
					var series = isSeries(item);
					var type = series ? "series" : "movie";
					var apiPath = series
						? "api/series/show/" + item.id + "/" + TOKEN
						: "api/media/detail/" + item.id + "/" + TOKEN;
					return new MultimediaItem({
						title: item.name || "Unknown",
						url: BASE_URL + "/" + apiPath,
						posterUrl: item.poster_path || "",
						type: type,
						score:
							item.vote_average != null
								? parseFloat(item.vote_average)
								: undefined,
					});
				})
				.filter(function (it) {
					return it !== null;
				});
			cb({ success: true, data: items });
		} catch (e) {
			cb({
				success: false,
				errorCode: "SEARCH_ERROR",
				message: String(e && e.message ? e.message : e),
			});
		}
	}

	async function load(url, cb) {
		try {
			var res = await http_get(url, { headers: COMMON_HEADERS });
			if (!res || !res.body) throw new Error("Empty response");
			var json = JSON.parse(res.body);
			var title = json.name || json.title || "Unknown";
			var posterUrl = json.poster_path || "";
			var bannerUrl = json.backdrop_path_tv || json.backdrop_path || posterUrl;
			var description = json.overview || "";
			var releaseDate = json.first_air_date || json.release_date || "";
			var year = releaseDate
				? parseInt(releaseDate.split("-")[0], 10)
				: undefined;
			var score =
				json.vote_average != null ? parseFloat(json.vote_average) : undefined;
			var cast = (json.casterslist || [])
				.map(function (c) {
					if (!c || !c.original_name) return null;
					return new Actor({
						name: c.original_name,
						role: c.character || "",
						image: c.profile_path || "",
					});
				})
				.filter(function (a) {
					return a !== null;
				});
			var seasons = json.seasons;
			var hasSeries = Array.isArray(seasons) && seasons.length > 0;
			var type = hasSeries ? "series" : "movie";
			var episodes = [];
			if (hasSeries) {
				for (var s = 0; s < seasons.length; s++) {
					var seasonObj = seasons[s];
					var seasonNum = seasonObj.season_number || 1;
					var epList = seasonObj.episodes || [];
					for (var e = 0; e < epList.length; e++) {
						var ep = epList[e];
						var videoLinks = (ep.videos || [])
							.filter(function (v) {
								return v && v.link;
							})
							.map(function (v) {
								return {
									link: String(v.link).trim(),
									server: v.server || "",
									lang: v.lang || "",
								};
							});
						episodes.push(
							new Episode({
								name: ep.name || "Episode " + (ep.episode_number || "?"),
								url: JSON.stringify(videoLinks),
								season: seasonNum,
								episode: ep.episode_number || 1,
								posterUrl: ep.still_path_tv || ep.still_path || posterUrl,
								description: ep.overview || "",
							}),
						);
					}
				}
				episodes.sort(function (a, b) {
					return a.season - b.season || a.episode - b.episode;
				});
			} else {
				var videoLinks = (json.videos || [])
					.filter(function (v) {
						return v && v.link;
					})
					.map(function (v) {
						return {
							link: String(v.link).trim(),
							server: v.server || "",
							lang: v.lang || "",
						};
					});
				episodes.push(
					new Episode({
						name: title,
						url: JSON.stringify(videoLinks),
						season: 1,
						episode: 1,
						posterUrl: posterUrl,
					}),
				);
			}
			cb({
				success: true,
				data: new MultimediaItem({
					title: title,
					url: url,
					posterUrl: posterUrl,
					bannerUrl: bannerUrl,
					description: description,
					type: type,
					year: year,
					score: score,
					cast: cast,
					syncData: {
						imdb: json.imdb_external_id || undefined,
						tmdb: json.tmdb_id ? String(json.tmdb_id) : undefined,
					},
					episodes: episodes,
				}),
			});
		} catch (e) {
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: String(e && e.message ? e.message : e),
			});
		}
	}

	async function verifyStreamItem(item, baseHeaders) {
		var rawLink = httpsify(String(item.link).trim());
		if (!rawLink) return null;
		var server = item.server || "MovieBlast";
		var lang = item.lang || "";
		var quality = matchQuality(server, rawLink);
		var label = createSourceLabel(server, lang, quality, rawLink);
		for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			var signedUrl = generateSignedUrl(rawLink);
			if (!signedUrl) break;
			try {
				var res = await httpGetWithTimeout(signedUrl, baseHeaders, TIMEOUT_MS);
				if (res && res.status >= 200 && res.status < 400) {
					return new StreamResult({
						url: signedUrl,
						quality: quality,
						headers: Object.assign({}, baseHeaders),
						source: label,
					});
				}
			} catch (_) {}
		}
		var fallbackUrl = generateSignedUrl(rawLink);
		if (!fallbackUrl) return null;
		return new StreamResult({
			url: fallbackUrl,
			quality: quality,
			headers: Object.assign({}, baseHeaders),
			source: label,
		});
	}

	async function loadStreams(url, cb) {
		try {
			var videoLinks;
			try {
				videoLinks = JSON.parse(url);
			} catch (_) {
				videoLinks = [{ link: url, server: "MovieBlast", lang: "" }];
			}
			if (!Array.isArray(videoLinks) || videoLinks.length === 0)
				return cb({ success: true, data: [] });
			var isTV =
				typeof manifest !== "undefined" &&
				manifest != null &&
				manifest.platform != null &&
				String(manifest.platform).toLowerCase().indexOf("tv") !== -1;
			var baseHeaders = isTV ? PLAYBACK_HEADERS_TV : PLAYBACK_HEADERS;
			var promises = [];
			for (var i = 0; i < videoLinks.length; i++) {
				var item = videoLinks[i];
				if (!item || !item.link) continue;
				promises.push(verifyStreamItem(item, baseHeaders));
			}
			var results = await Promise.all(promises);
			var streams = [];
			for (var i = 0; i < results.length; i++) {
				if (results[i] !== null) streams.push(results[i]);
			}
			cb({ success: true, data: streams });
		} catch (e) {
			cb({
				success: false,
				errorCode: "STREAM_ERROR",
				message: String(e && e.message ? e.message : e),
			});
		}
	}

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
