// Lobby: (1) remember every human player's UberId by display name so the in-game reporter can
// attach ids to the army table (the server only sends names into live_game);
// (2) show each player's overall rating next to their name.
(function () {
    var R = window.paRating;
    if (!R || !window.model)
        return;

    // ---- (1) id capture ----
    function capture() {
        var ids = R.getIds();
        var changed = false;
        _.forEach(model.armies(), function (army) {
            _.forEach(army.slots(), function (slot) {
                if (!slot.isPlayer() || slot.ai())
                    return;
                var name = slot.playerName();
                var id = slot.playerId();
                if (name && R.isUberId(String(id)) && ids[name] !== String(id)) {
                    ids[name] = String(id);
                    changed = true;
                }
            });
        });
        // ourselves, for the non-UberNet case where slot ids are names
        try {
            var me = model.displayName && model.displayName();
            var myId = model.uberId && model.uberId();
            if (me && R.isUberId(String(myId)) && ids[me] !== String(myId)) {
                ids[me] = String(myId);
                changed = true;
            }
        } catch (e) { }
        if (changed)
            R.setIds(ids);
    }

    // A fresh lobby should not inherit the previous lobby's map.
    R.setIds({});
    capture();
    setInterval(capture, 3000);

    // ---- (2) rating badges ----
    var LADDER = 'overall';
    var texts = {};        // uberId -> ko.observable(badge text)
    var pending = {};      // uberId -> true while a lookup is queued
    var timer = null;

    function fetchPending() {
        timer = null;
        var ids = _.keys(pending);
        pending = {};
        if (!ids.length)
            return;
        R.post('/api/players', { uber_ids: ids }, function (ok, data) {
            _.forEach(ids, function (id) {
                var entry = ok && data && data[id] && data[id].ladders && data[id].ladders[LADDER];
                if (entry)
                    texts[id]('[' + entry.rating + ']');
                else if (ok)
                    texts[id]('[new]');
                else
                    texts[id]('');
            });
        });
    }

    function textFor(id) {
        if (!texts[id]) {
            texts[id] = ko.observable('');
            pending[id] = true;
            if (!timer)
                timer = setTimeout(fetchPending, 400);
        }
        return texts[id];
    }

    // Called from the slot template; returns an observable so knockout re-renders when the lookup lands.
    model.paRatingBadge = function (slot) {
        return ko.computed(function () {
            if (slot.ai && slot.ai())
                return '';
            var id = slot.playerId && slot.playerId();
            if (!R.isUberId(String(id)))
                return '';
            return textFor(String(id))();
        });
    };

    // Refresh cached ratings when the lobby has been open a while (a game may have finished elsewhere).
    setInterval(function () {
        _.forEach(_.keys(texts), function (id) { pending[id] = true; });
        if (!timer && _.keys(pending).length)
            timer = setTimeout(fetchPending, 400);
    }, 120000);

    // Scene mods run before ko.applyBindings, so the template can still be edited.
    $('div.slot-player-text.truncate').after(
        '<div class="pa-rating-badge" title="PA rating (overall)" data-bind="text: model.paRatingBadge(slot)"></div>'
    );
})();
