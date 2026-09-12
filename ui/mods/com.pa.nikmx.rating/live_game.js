// In-game reporter: watches army state, records elimination order, and on game over sends one
// match report to the rating service. Every client sends its own view; the service reconciles them.
(function () {
    var R = window.paRating;
    if (!R || !window.model || !window.handlers)
        return;

    var simTime = 0;               // latest sim time seen (seconds)
    var defeatedAt = {};           // army id -> sim time when `defeated` first became true
    var gameOverInfo = null;       // duration/elapsed/winner from the game_over client_state
    var wasParticipant = false;
    var sent = false;
    var startedAt = Date.now();

    var isLocalGame = ko.observable().extend({ session: 'is_local_game' });
    var serverType = ko.observable().extend({ session: 'game_server_type' });
    var gameType = ko.observable().extend({ session: 'game_type' });

    // ---- hooks into the scene's message handlers ----
    var origTime = handlers.time;
    handlers.time = function (payload) {
        if (payload && payload.view === 0 && typeof payload.end_time === 'number')
            simTime = payload.end_time;
        return origTime.apply(this, arguments);
    };

    var origClientState = handlers.client_state;
    handlers.client_state = function (client) {
        if (client && (client.winner || client.loser || typeof client.duration === 'number'))
            gameOverInfo = { duration: client.duration, elapsed: client.elapsed, winner: !!client.winner, loser: !!client.loser };
        return origClientState.apply(this, arguments);
    };

    // ---- elimination order ----
    function trackDefeats() {
        _.forEach(model.players(), function (army) {
            if (army.defeated && defeatedAt[army.id] === undefined)
                defeatedAt[army.id] = simTime;
        });
        if (model.armyId() !== undefined)
            wasParticipant = true;
    }
    model.players.subscribe(trackDefeats);
    trackDefeats();

    // ---- report ----
    function shouldReport() {
        if (sent)
            return false;
        var mode = model.mode();
        if (mode === 'replay' || model.viewReplay && model.viewReplay())
            return false;
        if ((model.sandbox && model.sandbox()) || (model.gameOptions && model.gameOptions.sandbox && model.gameOptions.sandbox()))
            return false;
        if (model.gameOptions && model.gameOptions.isGalaticWar && model.gameOptions.isGalaticWar())
            return false;
        return true;
    }

    function buildArmies() {
        var ids = R.getIds();
        var armies = [];
        _.forEach(model.players(), function (army, index) {
            var isAi = !!army.ai;
            // army.slots and army.commanders are parallel arrays (playing_shared.js armyDesc)
            var players = [];
            if (!isAi) {
                _.forEach(army.slots || [], function (n, i) {
                    if (!n)
                        return;
                    var cmd = (army.commanders || [])[i];
                    if (cmd && typeof cmd === 'object')
                        cmd = cmd.UnitSpec || cmd.spec || cmd.unit || '';
                    players.push({ name: n, uber_id: ids[n] || null, commander: typeof cmd === 'string' ? cmd : '' });
                });
            }
            // our own slot: the lobby map may be missing in ranked games
            var me = model.playerName && model.playerName();
            if (!isAi && me && army.id === model.armyId()) {
                _.forEach(players, function (p) {
                    if (p.name === me && !p.uber_id && R.isUberId(String(model.uberId())))
                        p.uber_id = String(model.uberId());
                });
            }
            var pers = army.personality || null;
            armies.push({
                index: index,
                id: army.id,
                name: army.name || '',
                ai: isAi,
                personality: pers ? { name: pers.name || pers.display_name || '', display_name: pers.display_name || '' } : null,
                alliance_group: army.alliance_group || 0,
                players: players,
                won: !army.defeated,
                defeated: !!army.defeated,
                defeated_at_s: defeatedAt[army.id] !== undefined ? defeatedAt[army.id] : null,
                disconnected: !!army.disconnected,
                surrendered: !!army.surrendered
            });
        });
        return armies;
    }

    function resolveMissingIds(armies) {
        // Ranked / direct-connect games never went through the lobby scene: ask UberNet for ids.
        var pending = [];
        _.forEach(armies, function (a) {
            _.forEach(a.players, function (p) {
                if (!p.uber_id)
                    pending.push(R.lookupUberId(p.name).then(function (id) { if (id) p.uber_id = id; }));
            });
        });
        var d = $.Deferred();
        if (!pending.length) {
            d.resolve(armies);
            return d.promise();
        }
        var timer = setTimeout(function () { d.resolve(armies); }, 8000);
        $.when.apply($, pending).always(function () {
            clearTimeout(timer);
            d.resolve(armies);
        });
        return d.promise();
    }

    // Faction = the commander's faction unit type (merged spec via the spec: protocol).
    var FACTION_TYPES = { UNITTYPE_Custom58: 'MLA', UNITTYPE_Custom1: 'Legion', UNITTYPE_Custom2: 'Bugs', UNITTYPE_Custom6: 'Exiles' };
    var factionCache = {};

    function factionOf(commanderPath) {
        var d = $.Deferred();
        if (!commanderPath) { d.resolve(null); return d.promise(); }
        if (factionCache[commanderPath] !== undefined) { d.resolve(factionCache[commanderPath]); return d.promise(); }
        try {
            $.get('spec:/' + commanderPath).then(function (data) {
                var spec = data;
                try { if (typeof spec === 'string') spec = JSON.parse(spec); } catch (e) { spec = null; }
                var faction = null;
                _.forEach((spec && spec.unit_types) || [], function (t) {
                    if (!faction && FACTION_TYPES[t])
                        faction = FACTION_TYPES[t];
                });
                factionCache[commanderPath] = faction || 'unknown';
                d.resolve(factionCache[commanderPath]);
            }, function () { d.resolve(null); });
        } catch (e) { d.resolve(null); }
        return d.promise();
    }

    function resolveFactions(armies) {
        var pending = [];
        _.forEach(armies, function (a) {
            _.forEach(a.players, function (p) {
                pending.push(factionOf(p.commander).then(function (f) { p.faction = f; }));
            });
        });
        var d = $.Deferred();
        if (!pending.length) { d.resolve(armies); return d.promise(); }
        var timer = setTimeout(function () { d.resolve(armies); }, 5000);
        $.when.apply($, pending).always(function () { clearTimeout(timer); d.resolve(armies); });
        return d.promise();
    }

    function lobbyIdentity(armies) {
        var id = model.lobbyId && model.lobbyId();
        if (id && String(id) !== '-1' && String(id) !== 'undefined')
            return { id: String(id), source: 'ubernet' };
        var ents = [];
        _.forEach(armies, function (a) {
            if (a.ai)
                ents.push('ai:' + (a.personality ? a.personality.name : ''));
            _.forEach(a.players, function (p) { ents.push(p.uber_id || ('name:' + p.name)); });
        });
        ents.sort();
        var sys = (model.systemName && model.systemName()) || '';
        return { id: 'h' + R.fnv1a(sys + '|' + ents.join(',')), source: 'hash' };
    }

    function buildReport(armies) {
        var lobby = lobbyIdentity(armies);
        var duration = gameOverInfo && typeof gameOverInfo.duration === 'number' ? gameOverInfo.duration : simTime;
        var mods = [];
        try { mods = model.gameModIdentifiers ? (model.gameModIdentifiers() || []) : []; } catch (e) { }
        return {
            schema: R.SCHEMA,
            mod_version: R.MOD_VERSION,
            reporter: {
                uber_id: R.isUberId(String(model.uberId())) ? String(model.uberId()) : null,
                name: (model.playerName && model.playerName()) || (model.displayName && model.displayName()) || '',
                participant: wasParticipant
            },
            match: {
                lobby_id: lobby.id,
                lobby_id_source: lobby.source,
                server_type: serverType() || '',
                is_local: !!isLocalGame(),
                game_type: (model.gameOptions && model.gameOptions.game_type && model.gameOptions.game_type()) || gameType() || '',
                ranked: !!(model.ranked && model.ranked()),
                sandbox: !!((model.sandbox && model.sandbox()) || (model.gameOptions && model.gameOptions.sandbox && model.gameOptions.sandbox())),
                system_name: (model.systemName && model.systemName()) || '',
                server_mods: mods,
                duration_s: duration,
                sim_time_s: simTime,
                started_at: startedAt,
                ended_at: Date.now(),
                armies: armies
            }
        };
    }

    function onGameOver() {
        if (!shouldReport())
            return;
        sent = true;
        trackDefeats();
        var armies = buildArmies();
        var populated = _.filter(armies, function (a) { return a.ai || a.players.length; });
        if (populated.length < 2) {
            R.log('not reporting: fewer than two populated armies');
            return;
        }
        resolveMissingIds(armies).then(resolveFactions).then(function (resolved) {
            var report = buildReport(resolved);
            R.log('queueing report for lobby ' + report.match.lobby_id + ' (' + report.match.lobby_id_source + ')');
            R.enqueue(report);
            R.flush();
        });
    }

    model.gameOver.subscribe(function (value) {
        if (value)
            setTimeout(onGameOver, 1500); // let the final army_state land first
    });
    if (model.gameOver())
        setTimeout(onGameOver, 1500);
})();
