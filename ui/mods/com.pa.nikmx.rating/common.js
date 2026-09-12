// Shared helpers for the PA Rating Reporter mod. Coherent GT ~ Chrome 40: ES5 only, no fetch.
(function () {
    if (window.paRating)
        return;

    var MOD_VERSION = '0.2.1';
    var SCHEMA = 1;
    var DEFAULT_URL = 'https://nikolamx.pythonanywhere.com';
    var REPORT_KEY = '';               // must match PA_RATING_REPORT_KEY on the service; empty = none
    var QUEUE_KEY = 'pa_rating_queue';
    var IDS_KEY = 'pa_rating_ids';     // sessionStorage: { displayName: uberId } captured in the lobby
    var MAX_QUEUE = 50;

    function log(msg) {
        console.log('[pa-rating] ' + msg);
    }

    function baseUrl() {
        var u;
        try { u = localStorage.getItem('pa_rating_url'); } catch (e) { }
        u = (u || DEFAULT_URL).replace(/\/+$/, '');
        return u;
    }

    function readJson(storage, key, fallback) {
        try {
            var raw = storage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function writeJson(storage, key, value) {
        try { storage.setItem(key, JSON.stringify(value)); } catch (e) { }
    }

    function isUberId(id) {
        return typeof id === 'string' && /^\d{6,}$/.test(id);
    }

    // ---- lobby id map (name -> uberId) ----
    function getIds() { return readJson(sessionStorage, IDS_KEY, {}); }
    function setIds(map) { writeJson(sessionStorage, IDS_KEY, map); }

    // ---- outbound queue with retry ----
    function enqueue(payload) {
        var q = readJson(localStorage, QUEUE_KEY, []);
        q.push({ t: Date.now(), payload: payload });
        while (q.length > MAX_QUEUE)
            q.shift();
        writeJson(localStorage, QUEUE_KEY, q);
    }

    var flushing = false;
    function flush() {
        if (flushing)
            return;
        var q = readJson(localStorage, QUEUE_KEY, []);
        if (!q.length)
            return;
        flushing = true;
        var item = q[0];
        post('/api/report', item.payload, function (ok, resp) {
            flushing = false;
            if (ok || (resp && resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
                // delivered, or the service says the payload itself is bad -> drop it either way
                var cur = readJson(localStorage, QUEUE_KEY, []);
                cur = _.filter(cur, function (x) { return x.t !== item.t; });
                writeJson(localStorage, QUEUE_KEY, cur);
                if (ok)
                    log('report delivered (' + (resp && resp.match_status) + ')');
                else
                    log('report rejected by service: ' + (resp && resp.error));
                if (cur.length)
                    setTimeout(flush, 500);
            } else {
                log('report delivery failed, will retry later');
            }
        });
    }

    function post(path, body, cb) {
        var headers = {};
        if (REPORT_KEY)
            headers['X-PA-Rating-Key'] = REPORT_KEY;
        $.ajax({
            type: 'POST',
            url: baseUrl() + path,
            data: JSON.stringify(body),
            contentType: 'application/json; charset=utf-8',
            dataType: 'json',
            headers: headers,
            timeout: 15000,
            success: function (data) { cb(true, data); },
            error: function (xhr) {
                var resp = null;
                try { resp = JSON.parse(xhr.responseText); } catch (e) { }
                resp = resp || {};
                resp.status = xhr.status;
                cb(false, resp);
            }
        });
    }

    function get(path, cb) {
        $.ajax({
            type: 'GET',
            url: baseUrl() + path,
            dataType: 'json',
            timeout: 10000,
            success: function (data) { cb(true, data); },
            error: function () { cb(false, null); }
        });
    }

    // Resolve a display name to an UberId through UberNet (works for anyone, not just friends).
    function lookupUberId(name) {
        var d = $.Deferred();
        try {
            api.net.ubernet('/GameClient/UserId?' + $.param({ TitleDisplayName: name }), 'GET', 'text').then(function (text) {
                try {
                    var id = JSON.parse(text).UberId;
                    d.resolve(isUberId(String(id)) ? String(id) : null);
                } catch (e) { d.resolve(null); }
            }, function () { d.resolve(null); });
        } catch (e) {
            d.resolve(null);
        }
        return d.promise();
    }

    function fnv1a(str) {
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('00000000' + h.toString(16)).slice(-8);
    }

    window.paRating = {
        MOD_VERSION: MOD_VERSION,
        SCHEMA: SCHEMA,
        log: log,
        baseUrl: baseUrl,
        isUberId: isUberId,
        getIds: getIds,
        setIds: setIds,
        enqueue: enqueue,
        flush: flush,
        post: post,
        get: get,
        lookupUberId: lookupUberId,
        fnv1a: fnv1a
    };

    // deliver anything left over from a previous session
    setTimeout(flush, 3000);
})();
